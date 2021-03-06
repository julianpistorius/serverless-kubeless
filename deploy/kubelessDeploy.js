/*
 Copyright 2017 Bitnami.

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
*/

'use strict';

const _ = require('lodash');
const BbPromise = require('bluebird');
const Api = require('kubernetes-client');
const fs = require('fs');
const helpers = require('../lib/helpers');
const JSZip = require('jszip');
const moment = require('moment');
const path = require('path');
const url = require('url');

function getFunctionDescription(
  funcName,
  namespace,
  runtime,
  deps,
  funcContent,
  handler,
  desc,
  labels,
  env,
  memory,
  eventType,
  eventTrigger
) {
  const funcs = {
    apiVersion: 'k8s.io/v1',
    kind: 'Function',
    metadata: {
      name: funcName,
      namespace,
    },
    spec: {
      deps: deps || '',
      function: funcContent,
      handler,
      runtime,
    },
  };
  if (desc) {
    funcs.metadata.annotations = {
      'kubeless.serverless.com/description': desc,
    };
  }
  if (labels) {
    funcs.metadata.labels = labels;
  }
  if (env || memory) {
    const container = {
      name: funcName,
    };
    if (env) {
      container.env = [];
      _.each(env, (v, k) => {
        container.env.push({ name: k, value: v.toString() });
      });
    }
    if (memory) {
      // If no suffix is given we assume the unit will be `Mi`
      const memoryWithSuffix = memory.toString().match(/\d+$/) ?
        `${memory}Mi` :
        memory;
      container.resources = {
        limits: { memory: memoryWithSuffix },
        requests: { memory: memoryWithSuffix },
      };
    }
    funcs.spec.template = {
      spec: { containers: [container] },
    };
  }
  switch (eventType) {
    case 'http':
      funcs.spec.type = 'HTTP';
      break;
    case 'trigger':
      funcs.spec.type = 'PubSub';
      if (_.isEmpty(eventTrigger)) {
        throw new Error('You should specify a topic for the trigger event');
      }
      funcs.spec.topic = eventTrigger;
      break;
    default:
      throw new Error(`Event type ${eventType} is not supported`);
  }
  return funcs;
}

function getIngressDescription(funcName, funcPath, funcHost) {
  return {
    kind: 'Ingress',
    metadata: {
      name: `ingress-${funcName}`,
      labels: { function: funcName },
      annotations: {
        'kubernetes.io/ingress.class': 'nginx',
        'ingress.kubernetes.io/rewrite-target': '/',
      },
    },
    spec: {
      rules: [{
        host: funcHost,
        http: {
          paths: [{
            path: funcPath,
            backend: { serviceName: funcName, servicePort: 8080 },
          }],
        },
      }],
    },
  };
}

class KubelessDeploy {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.provider = this.serverless.getProvider('kubeless');

    this.hooks = {
      'deploy:deploy': () => BbPromise.bind(this)
        .then(this.validate)
        .then(this.deployFunction),
    };
    // Store the result of loading the Zip file
    this.loadZip = _.memoize(JSZip.loadAsync);
  }

  validate() {
    const unsupportedOptions = ['stage', 'region'];
    helpers.warnUnsupportedOptions(
      unsupportedOptions,
      this.options,
      this.serverless.cli.log.bind(this.serverless.cli)
    );
    // Check that functions don't have more than one event source
    // since it is not supported yet
    _.each(this.serverless.service.functions, f => {
      if (f.events && f.events.length > 1) {
        throw new Error('It is not supported to have more than one event source yet');
      }
    });
    return BbPromise.resolve();
  }

  getFunctionContent(relativePath) {
    const pkg = this.options.package ||
      this.serverless.service.package.path;
    let resultPromise = null;
    if (pkg) {
      resultPromise = this.loadZip(fs.readFileSync(pkg)).then(
        (zip) => zip.file(relativePath).async('string')
      );
    } else {
      resultPromise = new BbPromise((resolve, reject) => {
        fs.readFile(
          path.join(this.serverless.config.servicePath || '.', relativePath),
          (err, d) => {
            if (err) {
              reject(err);
            } else {
              resolve(d.toString());
            }
          });
      });
    }
    return resultPromise;
  }

  getThirdPartyResources(connectionOptions) {
    return new Api.ThirdPartyResources(connectionOptions);
  }

  getExtensions(connectionOptions) {
    return new Api.Extensions(connectionOptions);
  }

  getRuntimeFilenames(runtime, handler) {
    let files = null;
    if (runtime.match(/python/)) {
      files = {
        handler: `${handler.toString().split('.')[0]}.py`,
        deps: 'requirements.txt',
      };
    } else if (runtime.match(/node/)) {
      files = {
        handler: `${handler.toString().split('.')[0]}.js`,
        deps: 'package.json',
      };
    } else if (runtime.match(/ruby/)) {
      files = {
        handler: `${handler.toString().split('.')[0]}.rb`,
        deps: 'Gemfile',
      };
    } else {
      throw new Error(
        `The runtime ${runtime} is not supported yet`
      );
    }
    return files;
  }

  waitForDeployment(funcName, requestMoment, namespace) {
    const core = new Api.Core(helpers.getConnectionOptions(
      helpers.loadKubeConfig(), { namespace })
    );
    let retries = 0;
    let successfulCount = 0;
    let previousPodStatus = '';
    const loop = setInterval(() => {
      if (retries > 3) {
        this.serverless.cli.log(
          `Giving up, unable to retrieve the status of the ${funcName} deployment. `
        );
        clearInterval(loop);
        return;
      }
      let runningPods = 0;
      core.pods.get((err, podsInfo) => {
        if (err) {
          if (err.message.match(/request timed out/)) {
            this.serverless.cli.log('Request timed out. Retrying...');
          } else {
            throw err;
          }
        } else {
          // Get the pods for the current function
          const functionPods = _.filter(
            podsInfo.items,
            (pod) => (
              pod.metadata.labels.function === funcName &&
              // Ignore pods that may still exist from a previous deployment
              moment(pod.metadata.creationTimestamp) >= requestMoment
            )
          );
          if (_.isEmpty(functionPods)) {
            retries++;
            this.serverless.cli.log(
              `Unable to find any running pod for ${funcName}. Retrying...`
            );
          } else {
            _.each(functionPods, pod => {
              // We assume that the function pods will only have one container
              if (pod.status.containerStatuses) {
                if (pod.status.containerStatuses[0].ready) {
                  runningPods++;
                } else if (pod.status.containerStatuses[0].restartCount > 2) {
                  this.serverless.cli.log('ERROR: Failed to deploy the function');
                  process.exitCode = process.exitCode || 1;
                  clearInterval(loop);
                }
              }
            });
            if (runningPods === functionPods.length) {
              // The pods may be running for a short time
              // so we should ensure that they are stable
              successfulCount++;
              if (successfulCount === 2) {
                this.serverless.cli.log(
                  `Function ${funcName} succesfully deployed`
                );
                clearInterval(loop);
              }
            } else if (this.options.verbose) {
              successfulCount = 0;
              const currentPodStatus = _.map(functionPods, p => (
                p.status.containerStatuses ?
                  JSON.stringify(p.status.containerStatuses[0].state) :
                  'unknown'
              ));
              if (!_.isEqual(previousPodStatus, currentPodStatus)) {
                this.serverless.cli.log(
                  `Pods status: ${currentPodStatus}`
                );
                previousPodStatus = currentPodStatus;
              }
            }
          }
        }
      });
    }, 2000);
  }

  deployFunctionAndWait(body, thirdPartyResources) {
    const requestMoment = moment().milliseconds(0);
    this.serverless.cli.log(
      `Deploying function ${body.metadata.name}...`
    );
    return new BbPromise((resolve, reject) => {
      thirdPartyResources.ns.functions.post({ body }, (err) => {
        if (err) {
          if (err.code === 409) {
            this.serverless.cli.log(
              `The function ${body.metadata.name} already exists. ` +
              'Redeploy it usign --force or executing ' +
              `"sls deploy function -f ${body.metadata.name}".`
            );
            resolve(false);
          } else {
            reject(new Error(
              `Unable to deploy the function ${body.metadata.name}. Received:\n` +
              `  Code: ${err.code}\n` +
              `  Message: ${err.message}`
            ));
          }
        } else {
          this.waitForDeployment(
            body.metadata.name,
            requestMoment,
            thirdPartyResources.namespaces.namespace
          );
          resolve(true);
        }
      });
    });
  }

  redeployFunctionAndWait(body, thirdPartyResources) {
    const requestMoment = moment().milliseconds(0);
    return new BbPromise((resolve, reject) => {
      thirdPartyResources.ns.functions(body.metadata.name).put({ body }, (err) => {
        if (err) {
          reject(new Error(
            `Unable to update the function ${body.metadata.name}. Received:\n` +
            `  Code: ${err.code}\n` +
            `  Message: ${err.message}`
          ));
        } else {
          this.waitForDeployment(body.metadata.name, requestMoment);
          resolve(true);
        }
      });
    });
  }

  addIngressRuleIfNecessary(funcName, eventType, eventPath, eventHostname, namespace) {
    const config = helpers.loadKubeConfig();
    const extensions = this.getExtensions(helpers.getConnectionOptions(
      config, { namespace })
    );
    const fpath = eventPath || '/';
    const hostname = eventHostname ||
      `${url.parse(helpers.getKubernetesAPIURL(config)).hostname}.nip.io`;
    return new BbPromise((resolve, reject) => {
      if (
        eventType === 'http' &&
        ((!_.isEmpty(eventPath) && eventPath !== '/') || !_.isEmpty(eventHostname))
      ) {
        // Found a path to deploy the function
        const absolutePath = _.startsWith(fpath, '/') ?
          fpath :
          `/${fpath}`;
        const ingressDef = getIngressDescription(funcName, absolutePath, hostname);
        extensions.ns.ingress.post({ body: ingressDef }, (err) => {
          if (err) {
            reject(
              `Unable to deploy the function ${funcName} in the given path. ` +
              `Received: ${err.message}`
            );
          } else {
            if (this.options.verbose) {
              this.serverless.cli.log(`Deployed Ingress rule to map ${absolutePath}`);
            }
            resolve();
          }
        });
      } else {
        if (this.options.verbose) {
          this.serverless.cli.log('Skiping ingress rule generation');
        }
        resolve();
      }
    });
  }

  deployFunction() {
    const errors = [];
    let counter = 0;
    return new BbPromise((resolve, reject) => {
      _.each(this.serverless.service.functions, (description, name) => {
        if (description.handler) {
          const runtime = this.serverless.service.provider.runtime;
          const files = this.getRuntimeFilenames(runtime, description.handler);
          const connectionOptions = helpers.getConnectionOptions(
            helpers.loadKubeConfig(), {
              namespace: description.namespace ||
              this.serverless.service.provider.namespace,
            }
          );
          const thirdPartyResources = this.getThirdPartyResources(connectionOptions);
          thirdPartyResources.addResource('functions');
          this.getFunctionContent(files.handler)
            .then(functionContent => {
              this.getFunctionContent(files.deps)
                .catch(() => {
                  // No requirements found
                })
                .then((requirementsContent) => {
                  const events = !_.isEmpty(description.events) ?
                    description.events :
                    [{ http: { path: '/' } }];
                  _.each(events, event => {
                    const eventType = _.keys(event)[0];
                    const funcs = getFunctionDescription(
                      name,
                      thirdPartyResources.namespaces.namespace,
                      this.serverless.service.provider.runtime,
                      requirementsContent,
                      functionContent,
                      description.handler,
                      description.description,
                      description.labels,
                      description.environment,
                      description.memorySize || this.serverless.service.provider.memorySize,
                      eventType,
                      event.trigger
                    );
                    let deploymentPromise = null;
                    let redeployed = false;
                    thirdPartyResources.ns.functions.get((err, functionsInfo) => {
                      if (err) throw err;
                      // Check if the function has been already deployed
                      let existingFunction = false;
                      let existingSameFunction = false;
                      _.each(functionsInfo.items, item => {
                        if (_.isEqual(item.metadata.name, funcs.metadata.name)) {
                          existingFunction = true;
                          if (_.isEqual(item.spec, funcs.spec)) {
                            existingSameFunction = true;
                          }
                        }
                      });
                      if (existingSameFunction) {
                        // The same function is already deployed, skipping the deployment
                        this.serverless.cli.log(
                            `Function ${name} has not changed. Skipping deployment`
                          );
                        deploymentPromise = new BbPromise(r => r(false));
                      } else if (existingFunction && this.options.force) {
                        // The function already exits but with a different content
                        deploymentPromise = this.redeployFunctionAndWait(
                            funcs,
                            thirdPartyResources
                          );
                        redeployed = true;
                      } else {
                        deploymentPromise = this.deployFunctionAndWait(funcs, thirdPartyResources);
                      }
                      deploymentPromise.catch(deploymentErr => {
                        errors.push(deploymentErr);
                      })
                        .then((deployed) => {
                          if (!deployed || redeployed) {
                            // If there were an error with the deployment
                            // or the function is already deployed
                            // don't try to add an ingress rule
                            return new BbPromise((r) => r());
                          }
                          if (_.isUndefined(event[eventType])) {
                            throw new Error(
                              `Wrong defintion for the event ${event}. ` +
                              'Expecting an Object with valid keys.'
                            );
                          }
                          return this.addIngressRuleIfNecessary(
                            name,
                            eventType,
                            event[eventType].path,
                            this.serverless.service.provider.hostname || event[eventType].hostname,
                            connectionOptions.namespace
                          );
                        })
                        .catch(ingressErr => {
                          errors.push(ingressErr);
                        })
                        .then(() => {
                          counter++;
                          if (counter === _.keys(this.serverless.service.functions).length) {
                            if (_.isEmpty(errors)) {
                              resolve();
                            } else {
                              reject(
                                'Found errors while deploying the given functions:\n' +
                                `${errors.join('\n')}`
                              );
                            }
                          }
                        });
                    });
                  });
                });
            });
        } else {
          this.serverless.cli.log(
            `Skipping deployment of ${name} since it doesn't have a handler`
          );
        }
      });
    });
  }
}

module.exports = KubelessDeploy;
