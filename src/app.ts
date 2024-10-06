import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { DeployConfig, parseConfig } from "./config";
import { App as CdkApp } from "cdktf";
import { EC2, Instance as EC2Instance } from "@aws-sdk/client-ec2";
import { lb } from "@cdktf/provider-aws";
import { sleep } from "./util";
import { AutoScaling, LifecycleState } from "@aws-sdk/client-auto-scaling";
import { LoadBalancerStack } from "./stacks/LoadBalancerStack";
import { PodStack } from "./stacks/PodStack";
import { generateDeployScript } from "./util";
import { execa } from "execa";

const MAX_RELEASES_TO_KEEP = 3;
const TF_ENVARS = { TF_IN_AUTOMATION: "1" };

type ExitStatus = number;

export class App {
  private config: DeployConfig;

  constructor(
    private readonly cliPath: string,
    private readonly options: Record<string, string | boolean>
  ) {
    this.options = JSON.parse(JSON.stringify(options));
    this.config = parseConfig(this.options.config as string);
    this.createCdktfJson();
  }

  public async synth(
    stacks: string[] = this.getAllStackIds()
  ): Promise<ExitStatus> {
    const child = await this.runCommand(
      ["bunx", "cdktf", "synth", ...this.normalizeStackIds(stacks)],
      { env: { ...process.env, ...TF_ENVARS } }
    );
    return child.exited;
  }

  public async plan(stacks: string[]): Promise<ExitStatus> {
    const stackIds = stacks.length
      ? this.normalizeStackIds(stacks)
      : this.getAllStackIds();
    console.info("Planning stacks:", stackIds);

    await this._synth();

    const failed: unknown[] = [];
    const results = await Promise.allSettled(
      stackIds.map(
        (stackId) =>
          execa({ all: true })`bunx cdktf plan --skip-synth ${stackId}`
      )
    );
    for (let i = 0; i < stackIds.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        failed.push(result.reason);
      } else {
        console.info(
          "=========================================================================================="
        );
        console.info(`${stackIds[i]} plan output`);
        console.info(
          "↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓"
        );
        console.log(result.value.all);
        console.log("exit status", result.value.exitCode);
      }
    }

    if (failed.length) {
      console.log("Plan failures", failed);
      return 1;
    }

    return 0;
  }

  public async deploy(stacks: string[]): Promise<ExitStatus> {
    if (this.options.applyOnly && this.options.skipApply) {
      throw new Error(
        "Cannot specify --apply-only and --skip-apply as they are mutually exclusive"
      );
    }

    const stackIds = stacks.length
      ? this.normalizeStackIds(stacks)
      : this.getAllStackIds();
    const podNames = this.extractPodNames(stackIds);

    // Find any other stacks that need to be included in the deploy (e.g. load balancers)
    for (const [podName, podConfig] of Object.entries(this.config.pods)) {
      if (podNames.length > 0 && !podNames.includes(podName)) {
        continue;
      }
      const referencedLbs = Object.values(podConfig.endpoints || {})
        .map((endpointConfig) => endpointConfig.loadBalancer?.name)
        .filter((item) => !!item) as string[];
      for (const stackId of referencedLbs.map(
        (lbName) => `${this.config.project}-lb-${lbName}`
      )) {
        if (!stackIds.includes(stackId)) {
          stackIds.push(stackId);
        }
      }
    }

    console.info("Deploying stacks:", stackIds);

    const release = this.generateReleaseId();

    for (const [podName, podConfig] of Object.entries(this.config.pods)) {
      if (podNames.length > 0 && !podNames.includes(podName)) {
        continue;
      }

      if (Array.isArray(podConfig.environment)) {
        for (const envName of podConfig.environment) {
          if (process.env[envName] === undefined) {
            throw new Error(
              `Environment variable ${envName} is required by pod ${podName}, but was not provided in the environment`
            );
          }
          if (envName.includes("=")) {
            throw new Error(
              `Environment variable ${envName} contains an equals sign, which is not allowed. Use a map if you want to provide explicit values`
            );
          }
        }
      } else if (typeof podConfig.environment === "object") {
        for (const [envName, envValue] of Object.entries(
          podConfig.environment
        )) {
          if (
            (envValue === null || envValue === undefined) &&
            (envValue === process.env[envName]) === undefined
          ) {
            throw new Error(
              `Environment variable ${envName} is required by pod ${podName}, but was not provided in the environment`
            );
          }
        }
      }
    }

    // Get current instances before making any changes
    const alreadyRunningInstances = this.options.applyOnly
      ? []
      : await this.alreadyRunningInstances(podNames);

    console.log(
      `Detected ${alreadyRunningInstances.length} already running instances`
    );

    if (!this.options.skipApply) {
      const child = await this.runCommand(
        [
          "bunx",
          "cdktf",
          "apply",
          ...(this.options.yes ? ["--auto-approve"] : []),
          ...stackIds,
        ],
        { env: { ...process.env, ...TF_ENVARS } }
      );
      if (child.exitCode !== 0) return child.exited;
    }

    // Only perform a swap if there are already running instances.
    if (!this.options.applyOnly && alreadyRunningInstances.length) {
      return this.swapContainers(release, alreadyRunningInstances, podNames);
    }

    // TODO: Wait until all ASGs are healthy and at desired count

    return 0;
  }

  private async swapContainers(
    releaseId: string,
    alreadyRunningInstances: EC2Instance[],
    podsToDeploy: string[]
  ): Promise<ExitStatus> {
    const asg = new AutoScaling({ region: this.config.region });
    const instancesForPod: Record<string, EC2Instance[]> = {};

    console.log("Swapping containers for pods", podsToDeploy);

    // HACK: Clear known hosts file to avoid issues with SSH client
    // when connecting via jump host
    await $`rm -f ~/.ssh/known_hosts`;

    let updateFailed = false;
    const updateResults = await Promise.allSettled(
      Object.entries(this.config.pods).map(async ([podName, podOptions]) => {
        if (podsToDeploy.length > 0 && !podsToDeploy.includes(podName)) {
          return; // Skip pod
        }

        if (podOptions.deploy.replaceWith !== "new-containers") {
          return; // Nothing to do
        }

        // If pod is part of ASG, check desired capacity before proceeding
        if (podOptions.autoscaling) {
          const asgName = `${this.config.project}-${podName}`;
          const asgResult = await asg.describeAutoScalingGroups({
            AutoScalingGroupNames: [asgName],
          });
          const group = asgResult.AutoScalingGroups?.find(
            (asg) => asg.AutoScalingGroupName === asgName
          );

          if (group?.DesiredCapacity === 0) {
            console.warn(`Desired capacity for ${asgName} is 0. Skipping`);
            return;
          }
        }

        const alreadyRunningPodInstances = alreadyRunningInstances.filter(
          (instance) => {
            const instancePod = instance.Tags?.findLast(
              (tag) => tag.Key === "pod"
            )?.Value;
            return instancePod === podName;
          }
        );

        if (!alreadyRunningPodInstances?.length) {
          if (podOptions.singleton) {
            console.error(
              `No existing instances found for pod ${podName}, but desired capacity is > 0. Canceling deploy.`
            );
            throw new Error(
              `No existing instances found for pod ${podName}, but desired capacity is > 0`
            );
          }
          return; // No instances to swap containers on
        }

        // Remember for later
        instancesForPod[podName] = alreadyRunningPodInstances;

        const composeContents = readFileSync(podOptions.compose).toString();
        const pullResults = await Promise.allSettled(
          alreadyRunningPodInstances.map(async ({ PrivateIpAddress: ip }) => {
            const startTime = Date.now();
            while (Date.now() - startTime < 120_000) {
              try {
                const { sshUser, bastionUser, bastionHost } = podOptions;

                console.log(
                  `About to pull new containers for pod ${podName} on ${sshUser}@${ip}...`
                );

                // Record the current host key (workaround for SSH client jump host bug)
                await $`ssh -T -F /dev/null -o LogLevel=ERROR -o BatchMode=yes -o StrictHostKeyChecking=no ${bastionUser}@${bastionHost} true`;

                const connectResult =
                  await $`ssh -T -F /dev/null -J ${bastionUser}@${bastionHost} -o LogLevel=ERROR -o BatchMode=yes -o StrictHostKeyChecking=no ${sshUser}@${ip} bash -s < ${new Response(`
  ${generateDeployScript(
    this.config.project,
    podName,
    podOptions,
    releaseId,
    composeContents,
    this.allowedPodSecrets(podName)
  )}
              `)}`;
                if (connectResult.exitCode !== 0) {
                  console.error(
                    "STDOUT",
                    connectResult.stdout.toString(),
                    "STDERR",
                    connectResult.stderr.toString()
                  );
                  throw new Error(
                    `Error connecting to ${ip} (exit code ${connectResult.exitCode})`
                  );
                }

                break; // Otherwise we were successful
              } catch (e: unknown) {
                if (Date.now() - startTime > 120_000) {
                  console.error(
                    `Unable to connect to ${ip} after 2 minutes. Aborting deploy.`
                  );
                  throw e;
                }
                console.error(
                  `Unable to connect to ${ip}. Retrying in 5 seconds...`,
                  e
                );
                await sleep(5000);
              }
            }
          })
        );
        for (const result of pullResults) {
          if (result.status === "rejected") {
            updateFailed = true;
            console.error(result.reason);
          }
        }
      })
    );

    for (const result of updateResults) {
      if (result.status === "rejected") {
        updateFailed = true;
        console.error(result.reason);
      }
    }
    if (updateFailed) {
      console.error(
        "One or more pods failed to download/start the latest images specified in their respective Docker Compose file(s). Aborting deploy."
      );
      return 1;
    }

    // Swap all instances to start using the new containers
    const swapResults = await Promise.allSettled(
      Object.entries(this.config.pods).map(async ([podName, podOptions]) => {
        if (podsToDeploy.length > 0 && !podsToDeploy.includes(podName)) return; // Skip pod

        if (podOptions.deploy.replaceWith !== "new-containers") {
          return; // Nothing to do
        }

        const asgName = `${this.config.project}-${podName}`;
        const { sshUser, bastionUser, bastionHost } = podOptions;

        for (const {
          PrivateIpAddress: ip,
          InstanceId: instanceId,
        } of instancesForPod[podName]) {
          if (
            podOptions.autoscaling &&
            podOptions.deploy.detachBeforeContainerSwap
          ) {
            // Detach from ASG so that traffic from LB is not sent to the instance
            // Stop sending load balancer traffic to instance
            await asg.enterStandby({
              AutoScalingGroupName: asgName,
              ShouldDecrementDesiredCapacity: true,
              InstanceIds: [instanceId as string],
            });

            const beginTime = Date.now();
            for (;;) {
              const standbyInstances = await asg.describeAutoScalingInstances({
                InstanceIds: [instanceId as string],
              });
              const standbyDetails =
                standbyInstances.AutoScalingInstances || [];
              if (
                standbyDetails.every(
                  (i) => i.LifecycleState === LifecycleState.STANDBY
                )
              ) {
                break;
              }
              if (Date.now() - beginTime > 60_000) {
                throw new Error(
                  `Instance ${instanceId} (${ip}) did not enter Standby state within 60 seconds.`
                );
              }
              console.info(
                `Waiting for instance ${instanceId} (${ip}) to enter Standby state...`
              );
              await sleep(5000);
            }
          }

          console.log(`About to swap containers on ${sshUser}@${ip}`);

          // Swap the containers
          const connectResult =
            await $`ssh -T -F /dev/null -J ${bastionUser}@${bastionHost} -o LogLevel=ERROR -o BatchMode=yes -o StrictHostKeyChecking=no ${sshUser}@${ip} bash -s < ${new Response(
              `# Execute these commands on the remote server in a Bash shell
  set -ex -o pipefail

  # Stop the current release if there is one
  echo "Stopping containers on ${instanceId} ${ip} for current release $(cat /home/${sshUser}/releases/current)"
  if [ -f /home/${sshUser}/releases/current ] && [ -d "$(cat /home/${sshUser}/releases/current)" ]; then
    cd "$(cat /home/${sshUser}/releases/current)"
  fi
  # Stop all pod containers if any are running
  docker ps --quiet --all | xargs --no-run-if-empty docker stop --time ${podOptions.deploy.shutdownTimeout}
  docker ps --quiet --all | xargs --no-run-if-empty docker rm --force --volumes
  if [ -f docker-compose.yml ]; then
    # Also remove any networks
    docker compose down --volumes --timeout ${podOptions.deploy.shutdownTimeout} # Blocks until finished or timed out
  fi

  new_release_dir="/home/${sshUser}/releases/${releaseId}"
  cd "$new_release_dir" 

  # Update "current" location to point to the new release
  echo "$new_release_dir" > /home/${sshUser}/releases/current

  # Update tags so we know which release this instance is currently on
  aws ec2 create-tags --tags "Key=release,Value=${releaseId}" "Key=Name,Value=${asgName}-${releaseId}" --resource "\$(cat /etc/instance-id)"

  # Start up all pod containers
  echo "Starting new containers on ${instanceId} ${ip} for new release ${releaseId}"
  docker compose up --detach

  # Delete old images + containers
  docker system prune --force
  
  # Clean up old releases 
  echo "Deleting old release directories on ${instanceId} ${ip}"
  cd /home/${sshUser}
  ls -I current releases | sort | head -n -${MAX_RELEASES_TO_KEEP} | xargs --no-run-if-empty -I{} rm -rf releases/{}
          `
            )}`;
          if (connectResult.exitCode !== 0) {
            console.error(
              "STDOUT",
              connectResult.stdout.toString(),
              "STDERR",
              connectResult.stderr.toString()
            );
            throw new Error(
              `Error connecting to ${ip} (exit code ${connectResult.exitCode})`
            );
          }

          if (podOptions.deploy.detachBeforeContainerSwap) {
            // Re-attach to ASG so we start receiving traffic again
            await asg.exitStandby({
              AutoScalingGroupName: asgName,
              InstanceIds: [instanceId as string],
            });
          }
        }
      })
    );

    let deployFailed = false;
    for (const result of swapResults) {
      if (result.status === "rejected") {
        deployFailed = true;
        console.error(result.reason);
      }
    }
    if (deployFailed) {
      console.error(
        "One or more pods failed to start up the latest containers. Aborting deploy."
      );
      return 1;
    }

    return 0;
  }

  public async destroy(stacks: string[]): Promise<ExitStatus> {
    const stackIds = stacks.length
      ? this.normalizeStackIds(stacks)
      : this.getAllStackIds();
    console.info("Destroying stacks:", stackIds);

    const child = await this.runCommand(
      [
        "bunx",
        "cdktf",
        "destroy",
        ...(this.options.yes ? ["--auto-approve"] : []),
        ...stackIds,
      ],
      { env: { ...process.env, ...TF_ENVARS } }
    );
    return child.exited;
  }

  public async lint(): Promise<ExitStatus> {
    // By the time we reach here the configuration has already been validated
    console.info(`Stack configuration '${this.options.config}' is valid`);
    return 0;
  }

  public async console(pod: string): Promise<ExitStatus> {
    if (pod && !this.config.pods[pod]) {
      console.error(`Stack does not have a pod named ${pod}`);
      return 1;
    }

    const ec2 = new EC2({ region: this.config.region });
    const result = await ec2.describeInstances({
      Filters: [
        {
          Name: "tag:project",
          Values: [this.config.project],
        },
        {
          Name: "instance-state-name",
          Values: ["running"],
        },
        ...(pod
          ? [
              {
                Name: "tag:pod",
                Values: [pod],
              },
            ]
          : []),
      ],
    });

    const instances =
      result.Reservations?.flatMap(
        (reservation) => reservation.Instances || []
      ) || [];
    if (instances.length === 0) {
      if (pod) {
        console.error(`No running instances found for pod ${pod}`);
      } else {
        console.error("No running instances found in this stack");
      }
      return 1;
    }

    if (instances.length === 1) {
      const instancePod = instances[0].Tags?.findLast(
        (tag) => tag.Key === "pod"
      )?.Value;

      if (!instancePod) {
        throw new Error(
          `Unable to determine pod for instance ${instances[0].InstanceId}`
        );
      }
      const { sshUser, bastionUser, bastionHost } =
        this.config.pods[instancePod];
      // Only one to chose from, so select automatically
      return this.sshInto(
        sshUser,
        instances[0].PrivateIpAddress as string,
        bastionUser,
        bastionHost
      );
    }

    const candidates: string[] = [];
    for (const instance of instances) {
      const instancePod = instance.Tags?.findLast(
        (tag) => tag.Key === "pod"
      )?.Value;
      const release = instance.Tags?.findLast(
        (tag) => tag.Key === "release"
      )?.Value;
      if (!instancePod || !release) continue;
      candidates.push(
        [
          instance.InstanceId?.padEnd(20, " "),
          instance.PrivateIpAddress?.padEnd(16, " "),
          release.padEnd(25, " "),
          instancePod.padEnd(25, " ").slice(0, 25),
        ].join(" ")
      );
    }

    const fzf = await $`fzf --height=~10 < ${new Response(
      candidates.join("\n")
    )}`;

    const choice = fzf.stdout.toString().trim();
    if (fzf.exitCode === 0) {
      const [instanceId, privateIp, , pod] = choice.split(/\s+/);
      console.info(
        `Connecting to pod ${pod} (${instanceId}) at ${privateIp}...`
      );
      const { sshUser, bastionUser, bastionHost } = this.config.pods[pod];
      return this.sshInto(sshUser, privateIp, bastionUser, bastionHost);
    } else {
      console.error("No instance selected");
      return 1;
    }
  }

  private async alreadyRunningInstances(pods: string[]) {
    const ec2 = new EC2({ region: this.config.region });
    const result = await ec2.describeInstances({
      Filters: [
        {
          Name: "tag:project",
          Values: [this.config.project],
        },
        {
          Name: "tag:pod",
          Values: pods,
        },
        {
          Name: "instance-state-name",
          Values: ["running"],
        },
      ],
    });

    const instances = result.Reservations?.flatMap(
      (reservation) => reservation.Instances || []
    );

    return instances || [];
  }

  private async sshInto(
    sshUser: string,
    host: string,
    bastionUser?: string,
    bastionHost?: string
  ): Promise<ExitStatus> {
    if (bastionUser && bastionHost) {
      // Accept the SSH host key for the bastion automatically (we don't store host keys)
      await execa({
        all: true,
      })`ssh -o LogLevel=ERROR -o BatchMode=yes -o StrictHostKeyChecking=no ${bastionUser}@${bastionHost} true`;
    }

    const sshResult = Bun.spawnSync(
      [
        "ssh",
        ...(bastionUser ? ["-J", `${bastionUser}@${bastionHost}`] : []),
        ...(this.options.yes ? ["-o", "BatchMode=yes"] : []),
        "-o",
        "LogLevel=ERROR",
        // Gets really annoying to have to clear your known hosts file
        // all the time, so don't bother with host key checking
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        `${sshUser}@${host}`,
      ],
      {
        stdio: ["inherit", "inherit", "inherit"],
      }
    );
    return sshResult.exitCode;
  }

  // Internal use only. Exposed for CDKTF interoperability
  public async _synth(options: { stacks?: string[]; release?: string } = {}) {
    const releaseId = options.release || this.generateReleaseId();

    const app = new CdkApp();

    // Create separate state file for each load balancer defined
    const lbs: Record<string, lb.Lb> = {};
    for (const [lbName, lbOptions] of Object.entries(
      this.config.loadBalancers || {}
    )) {
      const lbStack = new LoadBalancerStack(
        app,
        `${this.config.project}-lb-${lbName}`,
        {
          region: this.config.region,
          vpcId: this.config.network.id,
          project: this.config.project,
          shortName: lbName,
          type: lbOptions.type,
          public: lbOptions.public,
          subnets:
            (lbOptions.public
              ? this.config.network?.subnets?.public
              : this.config.network?.subnets?.private) || [],
          idleTimeout: lbOptions.idleTimeout,
        }
      );

      lbs[lbName] = lbStack.lb;
    }

    // Create separate state file for each pod so we can deploy/update them independently if desired
    // (this would otherwise be very difficult to do with Terraform's -target flag)
    //
    // This has the added benefit of speeding up the deploy for large applications when only a single
    // pod was modified.
    for (const [podName, podOptions] of Object.entries(this.config.pods)) {
      new PodStack(app, `${this.config.project}-pod-${podName}`, {
        releaseId,
        project: this.config.project,
        shortName: podName,
        region: this.config.region,
        vpcId: this.config.network.id,
        defaultSubnetIds: podOptions.singleton
          ? undefined
          : podOptions.publicIp
          ? this.config.network?.subnets?.public
          : this.config.network?.subnets?.private,
        secretMappings: this.allowedPodSecrets(podName),
        lbs,
        podOptions,
      });
    }
    app.synth();

    return 0;
  }

  private async runCommand(
    command: string[],
    options: Parameters<typeof Bun.spawn>[1] = {}
  ) {
    const subprocess = Bun.spawn(command, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      ...options,
    });
    await subprocess.exited;
    return subprocess;
  }

  private allowedPodSecrets(podName: string) {
    const allowedSecrets: Record<string, string> = {};
    for (const [secretName, secretOptions] of Object.entries(
      this.config.secrets || {}
    )) {
      if (
        Array.isArray(secretOptions.podsIncluded) &&
        secretOptions.podsIncluded?.length &&
        secretOptions.podsIncluded?.includes(podName)
      ) {
        allowedSecrets[secretName] = secretName; // Map to the same name
      } else if (
        typeof secretOptions.podsIncluded === "object" &&
        secretOptions.podsIncluded[podName] !== undefined
      ) {
        allowedSecrets[secretName] = secretOptions.podsIncluded[podName]; // Map secret name
      }
    }
    return allowedSecrets;
  }

  private createCdktfJson() {
    writeFileSync(
      "./cdktf.json",
      JSON.stringify({
        app: `bun ${this.cliPath} _cdktf-synth`,
        language: "typescript",
      })
    );
  }

  private generateReleaseId() {
    if (process.env.RELEASE) return process.env.RELEASE;
    return `${new Date()
      .toISOString()
      .replace(/\:/g, "-")
      .replace(/\./g, "-")
      .replace("Z", "z")}`;
  }

  private getAllStackIds() {
    const stackIds = Object.keys(this.config.loadBalancers || {})
      .map((lbName) => `${this.config.project}-lb-${lbName}`)
      .concat(
        Object.keys(this.config.pods || {}).map(
          (podName) => `${this.config.project}-pod-${podName}`
        )
      );
    return stackIds;
  }

  private normalizeStackIds(stacks: string[]) {
    return stacks.map((stackId) => {
      if (stackId.startsWith(`${this.config.project}-`)) {
        return stackId.replace(":", "-");
      }
      return `${this.config.project}-${stackId.replace(":", "-")}`;
    });
  }

  private extractPodNames(stacks: string[]) {
    const podStackIdPrefix = `${this.config.project}-pod-`;
    return this.normalizeStackIds(stacks)
      .filter((stackId) => stackId.startsWith(podStackIdPrefix))
      .map((stackId) =>
        stackId.replace(new RegExp(`^${podStackIdPrefix}`), "")
      );
  }
}
