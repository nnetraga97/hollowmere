import {
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  Validations,
  type StackProps,
} from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

export interface RuntimeRepositories {
  readonly web: ecr.IRepository;
  readonly scheduler: ecr.IRepository;
}

export interface HollowmereRuntimeStackProps extends StackProps {
  readonly repositories: RuntimeRepositories;
  readonly githubDeployRole: iam.IRole;
}

interface ServiceRoles {
  readonly execution: iam.Role;
  readonly task: iam.Role;
}

interface RuntimeParameters {
  readonly azureEmbeddingDeployment: CfnParameter;
  readonly azureReasoningDeployment: CfnParameter;
  readonly azureTerraDeployment: CfnParameter;
  readonly bedrockEmbeddingModelArn: CfnParameter;
  readonly bedrockReasoningModelArnUsEast1: CfnParameter;
  readonly bedrockReasoningModelArnUsEast2: CfnParameter;
  readonly bedrockReasoningModelArnUsWest2: CfnParameter;
  readonly bedrockReasoningProfileArn: CfnParameter;
  readonly bedrockSonnetProfileId: CfnParameter;
  readonly buildRevision: CfnParameter;
  readonly certificateArn: CfnParameter;
  readonly domainName: CfnParameter;
  readonly hostedZoneId: CfnParameter;
  readonly hostedZoneName: CfnParameter;
  readonly migrationImageTag: CfnParameter;
  readonly runtimeConfigSecretArn: CfnParameter;
  readonly schedulerImageTag: CfnParameter;
  readonly webImageTag: CfnParameter;
}

const APPLICATION_PORT = 3000;
const LOG_RETENTION = logs.RetentionDays.ONE_MONTH;

export class HollowmereRuntimeStack extends Stack {
  public constructor(
    scope: Construct,
    id: string,
    props: HollowmereRuntimeStackProps,
  ) {
    super(scope, id, props);

    const parameters = this.createParameters();
    const runtimeSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "RuntimeConfigSecret",
      parameters.runtimeConfigSecretArn.valueAsString,
    );

    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.42.0.0/16"),
      maxAzs: 2,
      natGateways: 0,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    Validations.of(vpc).acknowledge({
      id: "AwsSolutions::AwsSolutions-VPC7",
      reason:
        "The time-bounded hackathon stack omits paid flow-log storage; ALB, ECS, and application logs provide the required demo observability.",
    });

    const cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: "hollowmere",
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      vpc,
    });

    const albSecurityGroup = new ec2.SecurityGroup(this, "AlbSecurityGroup", {
      allowAllOutbound: false,
      description: "Internet ingress for Hollowmere HTTPS and HTTP redirect.",
      vpc,
    });
    const webSecurityGroup = this.createTaskSecurityGroup(
      vpc,
      "WebSecurityGroup",
      "Hollowmere web task; inbound only from the ALB.",
    );
    const schedulerSecurityGroup = this.createTaskSecurityGroup(
      vpc,
      "SchedulerSecurityGroup",
      "Hollowmere scheduler task; no inbound traffic.",
    );

    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
    Validations.of(albSecurityGroup).acknowledge({
      id: "AwsSolutions::AwsSolutions-EC23",
      reason:
        "The public ALB intentionally accepts only HTTP redirect traffic on 80 and HTTPS traffic on 443; no other ports are internet-accessible.",
    });
    albSecurityGroup.addEgressRule(
      webSecurityGroup,
      ec2.Port.tcp(APPLICATION_PORT),
    );
    webSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(APPLICATION_PORT),
    );

    const webLogGroup = this.createLogGroup("WebLogGroup", "/hollowmere/web");
    const schedulerLogGroup = this.createLogGroup(
      "SchedulerLogGroup",
      "/hollowmere/scheduler",
    );
    const migrationLogGroup = this.createLogGroup(
      "MigrationLogGroup",
      "/hollowmere/migration",
    );

    const webRoles = this.createServiceRoles(
      "Web",
      "hollowmere-web",
      props.repositories.web,
      webLogGroup,
      runtimeSecret,
      parameters,
      true,
    );
    const schedulerRoles = this.createServiceRoles(
      "Scheduler",
      "hollowmere-scheduler",
      props.repositories.scheduler,
      schedulerLogGroup,
      runtimeSecret,
      parameters,
      false,
    );
    const migrationRoles = this.createMigrationRoles(
      props.repositories.scheduler,
      migrationLogGroup,
      runtimeSecret,
    );

    const webTask = new ecs.FargateTaskDefinition(this, "WebTask", {
      family: "hollowmere-web",
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: webRoles.execution,
      taskRole: webRoles.task,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    Validations.of(webTask).acknowledge({
      id: "AwsSolutions::AwsSolutions-ECS2",
      reason:
        "Only non-sensitive runtime switches and deployment names are plain environment variables; credentials, database material, and the session secret use Secrets Manager injection.",
    });
    const webContainer = webTask.addContainer("WebContainer", {
      containerName: "web",
      image: ecs.ContainerImage.fromEcrRepository(
        props.repositories.web,
        parameters.webImageTag.valueAsString,
      ),
      environment: this.runtimeEnvironment(parameters, true),
      secrets: this.runtimeSecrets(runtimeSecret, true),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: webLogGroup,
        mode: ecs.AwsLogDriverMode.BLOCKING,
        streamPrefix: "web",
      }),
      stopTimeout: Duration.seconds(60),
    });
    webContainer.addPortMappings({
      containerPort: APPLICATION_PORT,
      protocol: ecs.Protocol.TCP,
    });

    const schedulerTask = new ecs.FargateTaskDefinition(this, "SchedulerTask", {
      family: "hollowmere-scheduler",
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole: schedulerRoles.execution,
      taskRole: schedulerRoles.task,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    Validations.of(schedulerTask).acknowledge({
      id: "AwsSolutions::AwsSolutions-ECS2",
      reason:
        "Only non-sensitive runtime switches and deployment names are plain environment variables; credentials and database material use Secrets Manager injection.",
    });
    schedulerTask.addContainer("SchedulerContainer", {
      containerName: "scheduler",
      image: ecs.ContainerImage.fromEcrRepository(
        props.repositories.scheduler,
        parameters.schedulerImageTag.valueAsString,
      ),
      environment: this.runtimeEnvironment(parameters, false),
      secrets: this.runtimeSecrets(runtimeSecret, false),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: schedulerLogGroup,
        mode: ecs.AwsLogDriverMode.BLOCKING,
        streamPrefix: "scheduler",
      }),
      stopTimeout: Duration.seconds(120),
    });

    const migrationTask = new ecs.FargateTaskDefinition(this, "MigrationTask", {
      family: "hollowmere-migration",
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: migrationRoles.execution,
      taskRole: migrationRoles.task,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    migrationTask.addContainer("MigrationContainer", {
      command: ["npm", "run", "db:migrate"],
      containerName: "migration",
      image: ecs.ContainerImage.fromEcrRepository(
        props.repositories.scheduler,
        parameters.migrationImageTag.valueAsString,
      ),
      secrets: {
        DATABASE_CA_CERT_BASE64: ecs.Secret.fromSecretsManager(
          runtimeSecret,
          "DATABASE_CA_CERT_BASE64",
        ),
        DATABASE_URL: ecs.Secret.fromSecretsManager(
          runtimeSecret,
          "DATABASE_MIGRATOR_URL",
        ),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: migrationLogGroup,
        mode: ecs.AwsLogDriverMode.BLOCKING,
        streamPrefix: "migration",
      }),
      stopTimeout: Duration.seconds(120),
    });

    const webService = new ecs.FargateService(this, "WebService", {
      serviceName: "hollowmere-web",
      assignPublicIp: true,
      circuitBreaker: { enable: true, rollback: true },
      cluster,
      desiredCount: 1,
      healthCheckGracePeriod: Duration.seconds(60),
      maxHealthyPercent: 200,
      minHealthyPercent: 100,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      securityGroups: [webSecurityGroup],
      taskDefinition: webTask,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const schedulerService = new ecs.FargateService(this, "SchedulerService", {
      serviceName: "hollowmere-scheduler",
      assignPublicIp: true,
      circuitBreaker: { enable: true, rollback: true },
      cluster,
      desiredCount: 1,
      maxHealthyPercent: 100,
      minHealthyPercent: 0,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      securityGroups: [schedulerSecurityGroup],
      taskDefinition: schedulerTask,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const loadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      "LoadBalancer",
      {
        deletionProtection: true,
        dropInvalidHeaderFields: true,
        internetFacing: true,
        securityGroup: albSecurityGroup,
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      },
    );
    Validations.of(loadBalancer).acknowledge({
      id: "AwsSolutions::AwsSolutions-ELB2",
      reason:
        "ALB access-log storage is deferred for the short-lived judged deployment; application and target-health logs remain enabled.",
    });

    loadBalancer.addListener("HttpListener", {
      defaultAction: elbv2.ListenerAction.redirect({
        permanent: true,
        port: "443",
        protocol: "HTTPS",
      }),
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "Certificate",
      parameters.certificateArn.valueAsString,
    );
    const httpsListener = loadBalancer.addListener("HttpsListener", {
      certificates: [certificate],
      open: false,
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
    });
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "WebTargetGroup", {
      deregistrationDelay: Duration.seconds(30),
      healthCheck: {
        enabled: true,
        healthyHttpCodes: "200",
        interval: Duration.seconds(30),
        path: "/api/health",
        timeout: Duration.seconds(5),
      },
      port: APPLICATION_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      vpc,
    });
    httpsListener.addTargetGroups("WebTargets", { targetGroups: [targetGroup] });
    webService.attachToApplicationTargetGroup(targetGroup);

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
      this,
      "HostedZone",
      {
        hostedZoneId: parameters.hostedZoneId.valueAsString,
        zoneName: parameters.hostedZoneName.valueAsString,
      },
    );
    new route53.ARecord(this, "PublicAliasRecord", {
      recordName: parameters.domainName.valueAsString,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(loadBalancer),
      ),
      zone: hostedZone,
    });

    this.addOperationalAlarms(
      cluster,
      webService,
      schedulerService,
      loadBalancer,
      targetGroup,
      webLogGroup,
      schedulerLogGroup,
    );
    this.extendDeployRole(
      props.githubDeployRole,
      cluster,
      webService,
      schedulerService,
      webRoles,
      schedulerRoles,
      migrationRoles,
    );

    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "LoadBalancerDnsName", {
      value: loadBalancer.loadBalancerDnsName,
    });
    new CfnOutput(this, "MigrationTaskDefinitionArn", {
      value: migrationTask.taskDefinitionArn,
    });
    new CfnOutput(this, "PublicUrl", {
      value: Fn.join("", ["https://", parameters.domainName.valueAsString]),
    });
  }

  private createParameters(): RuntimeParameters {
    const stringParameter = (id: string, description: string) =>
      new CfnParameter(this, id, { description, type: "String" });

    return {
      azureEmbeddingDeployment: stringParameter(
        "AzureEmbeddingDeployment",
        "Azure Foundry embedding deployment name.",
      ),
      azureReasoningDeployment: stringParameter(
        "AzureReasoningDeployment",
        "Azure Foundry efficient reasoning deployment name.",
      ),
      azureTerraDeployment: stringParameter(
        "AzureTerraDeployment",
        "Azure Foundry deployment assigned to the always-enabled Azure profile.",
      ),
      bedrockEmbeddingModelArn: stringParameter(
        "BedrockEmbeddingModelArn",
        "Exact Titan embedding foundation-model ARN.",
      ),
      bedrockReasoningModelArnUsEast1: stringParameter(
        "BedrockReasoningModelArnUsEast1",
        "Underlying reasoning foundation-model ARN in us-east-1.",
      ),
      bedrockReasoningModelArnUsEast2: stringParameter(
        "BedrockReasoningModelArnUsEast2",
        "Underlying reasoning foundation-model ARN in us-east-2.",
      ),
      bedrockReasoningModelArnUsWest2: stringParameter(
        "BedrockReasoningModelArnUsWest2",
        "Underlying reasoning foundation-model ARN in us-west-2.",
      ),
      bedrockReasoningProfileArn: stringParameter(
        "BedrockReasoningProfileArn",
        "Exact Bedrock cross-region inference-profile ARN.",
      ),
      bedrockSonnetProfileId: stringParameter(
        "BedrockSonnetProfileId",
        "Exact Claude Sonnet inference-profile ID used by Bedrock worlds.",
      ),
      buildRevision: stringParameter(
        "BuildRevision",
        "Git commit represented by the initial immutable task images.",
      ),
      certificateArn: stringParameter(
        "CertificateArn",
        "ARN of an issued ACM certificate for DomainName.",
      ),
      domainName: stringParameter(
        "DomainName",
        "Public Hollowmere hostname, without scheme.",
      ),
      hostedZoneId: stringParameter(
        "HostedZoneId",
        "Route 53 public hosted-zone ID for DomainName.",
      ),
      hostedZoneName: stringParameter(
        "HostedZoneName",
        "Route 53 public hosted-zone name.",
      ),
      migrationImageTag: stringParameter(
        "MigrationImageTag",
        "Immutable migration image tag stored in hollowmere-scheduler.",
      ),
      runtimeConfigSecretArn: new CfnParameter(this, "RuntimeConfigSecretArn", {
        description:
          "Complete ARN of the JSON Secrets Manager secret used at task launch.",
        noEcho: true,
        type: "String",
      }),
      schedulerImageTag: stringParameter(
        "SchedulerImageTag",
        "Immutable scheduler image tag.",
      ),
      webImageTag: stringParameter("WebImageTag", "Immutable web image tag."),
    };
  }

  private createTaskSecurityGroup(
    vpc: ec2.IVpc,
    id: string,
    description: string,
  ): ec2.SecurityGroup {
    const group = new ec2.SecurityGroup(this, id, {
      allowAllOutbound: false,
      description,
      vpc,
    });
    group.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
    group.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(26257));
    group.addEgressRule(
      ec2.Peer.ipv4("169.254.169.253/32"),
      ec2.Port.udp(53),
    );
    group.addEgressRule(
      ec2.Peer.ipv4("169.254.169.253/32"),
      ec2.Port.tcp(53),
    );
    return group;
  }

  private createLogGroup(id: string, logGroupName: string): logs.LogGroup {
    const group = new logs.LogGroup(this, id, {
      logGroupName,
      removalPolicy: RemovalPolicy.RETAIN,
      retention: LOG_RETENTION,
    });
    Validations.of(group).acknowledge({
      id: "AwsSolutions-CW1",
      reason:
        "The hackathon stack uses CloudWatch Logs service-managed encryption; no customer-managed KMS key is required for these application logs.",
    });
    return group;
  }

  private createServiceRoles(
    id: string,
    rolePrefix: string,
    repository: ecr.IRepository,
    logGroup: logs.ILogGroup,
    runtimeSecret: secretsmanager.ISecret,
    parameters: RuntimeParameters,
    streaming: boolean,
  ): ServiceRoles {
    const execution = new iam.Role(this, `${id}ExecutionRole`, {
      roleName: `${rolePrefix}-execution`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    repository.grantPull(execution);
    logGroup.grantWrite(execution);
    runtimeSecret.grantRead(execution);

    const task = new iam.Role(this, `${id}TaskRole`, {
      roleName: `${rolePrefix}-task`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    task.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeBedrockReasoning",
        actions: streaming
          ? ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
          : ["bedrock:InvokeModel"],
        resources: [
          parameters.bedrockReasoningProfileArn.valueAsString,
          parameters.bedrockReasoningModelArnUsEast1.valueAsString,
          parameters.bedrockReasoningModelArnUsEast2.valueAsString,
          parameters.bedrockReasoningModelArnUsWest2.valueAsString,
        ],
      }),
    );
    task.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeBedrockEmbedding",
        actions: ["bedrock:InvokeModel"],
        resources: [parameters.bedrockEmbeddingModelArn.valueAsString],
      }),
    );

    this.acknowledgeExecutionRoleWildcards(execution);
    return { execution, task };
  }

  private createMigrationRoles(
    repository: ecr.IRepository,
    logGroup: logs.ILogGroup,
    runtimeSecret: secretsmanager.ISecret,
  ): ServiceRoles {
    const execution = new iam.Role(this, "MigrationExecutionRole", {
      roleName: "hollowmere-migration-execution",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    repository.grantPull(execution);
    logGroup.grantWrite(execution);
    runtimeSecret.grantRead(execution);
    this.acknowledgeExecutionRoleWildcards(execution);

    const task = new iam.Role(this, "MigrationTaskRole", {
      roleName: "hollowmere-migration-task",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    return { execution, task };
  }

  private acknowledgeExecutionRoleWildcards(role: iam.Role): void {
    Validations.of(role).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "ecr:GetAuthorizationToken requires Resource *; repository pulls, secret reads, and log writes remain resource-scoped.",
    });
    Validations.of(role).acknowledge({
      id: "AwsSolutions-IAM5[Resource::<LogGroupArn>:*]",
      reason:
        "CloudWatch log-stream ARNs require a wildcard suffix beneath the one exact service log group.",
    });
  }

  private runtimeEnvironment(
    parameters: RuntimeParameters,
    web: boolean,
  ): Record<string, string> {
    const environment: Record<string, string> = {
      AWS_REGION: Stack.of(this).region,
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT:
        parameters.azureEmbeddingDeployment.valueAsString,
      AZURE_OPENAI_EMBEDDING_DIM: "1024",
      AZURE_OPENAI_REASONING_DEPLOYMENT:
        parameters.azureReasoningDeployment.valueAsString,
      AZURE_OPENAI_SOL_DEPLOYMENT:
        parameters.azureReasoningDeployment.valueAsString,
      AZURE_OPENAI_TERRA_DEPLOYMENT:
        parameters.azureTerraDeployment.valueAsString,
      BEDROCK_ENABLED: "false",
      BEDROCK_EMBEDDING_DIM: "1024",
      BEDROCK_EMBEDDING_MODEL: "amazon.titan-embed-text-v2:0",
      BEDROCK_MAX_ATTEMPTS: "5",
      BEDROCK_REASONING_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      BEDROCK_SONNET_REASONING_PROFILE:
        parameters.bedrockSonnetProfileId.valueAsString,
      BUILD_REVISION: parameters.buildRevision.valueAsString,
      INFERENCE_MODE: "world",
      LOG_LEVEL: "info",
      NODE_ENV: "production",
      SCENARIO_VERSION: "hollowmere-v5",
      SERVICE_NAME: web ? "hollowmere-web" : "hollowmere-scheduler",
    };
    if (web) {
      environment.CONVERSATION_RATE_LIMIT_PER_MINUTE = "20";
      environment.PUBLIC_ORIGIN = `https://${parameters.domainName.valueAsString}`;
      environment.READINESS_TIMEOUT_MS = "2000";
    }
    return environment;
  }

  private runtimeSecrets(
    secret: secretsmanager.ISecret,
    web: boolean,
  ): Record<string, ecs.Secret> {
    const values: Record<string, ecs.Secret> = {
      AZURE_OPENAI_API_KEY: ecs.Secret.fromSecretsManager(
        secret,
        "AZURE_OPENAI_API_KEY",
      ),
      AZURE_OPENAI_ENDPOINT: ecs.Secret.fromSecretsManager(
        secret,
        "AZURE_OPENAI_ENDPOINT",
      ),
      DATABASE_CA_CERT_BASE64: ecs.Secret.fromSecretsManager(
        secret,
        "DATABASE_CA_CERT_BASE64",
      ),
      DATABASE_URL: ecs.Secret.fromSecretsManager(secret, "DATABASE_URL"),
    };
    if (web) {
      values.SESSION_SECRET = ecs.Secret.fromSecretsManager(
        secret,
        "SESSION_SECRET",
      );
    }
    return values;
  }

  private addOperationalAlarms(
    cluster: ecs.ICluster,
    webService: ecs.FargateService,
    schedulerService: ecs.FargateService,
    loadBalancer: elbv2.ApplicationLoadBalancer,
    targetGroup: elbv2.ApplicationTargetGroup,
    webLogGroup: logs.LogGroup,
    schedulerLogGroup: logs.LogGroup,
  ): void {
    new cloudwatch.Alarm(this, "UnhealthyWebTargetsAlarm", {
      alarmName: "hollowmere-unhealthy-web-targets",
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      metric: new cloudwatch.Metric({
        namespace: "AWS/ApplicationELB",
        metricName: "UnHealthyHostCount",
        dimensionsMap: {
          LoadBalancer: loadBalancer.loadBalancerFullName,
          TargetGroup: targetGroup.targetGroupFullName,
        },
        period: Duration.minutes(1),
        statistic: "Maximum",
      }),
      threshold: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    for (const [id, service] of [
      ["Web", webService],
      ["Scheduler", schedulerService],
    ] as const) {
      new cloudwatch.Alarm(this, `${id}StoppedTasksAlarm`, {
        alarmName: `hollowmere-${id.toLowerCase()}-running-task-missing`,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 2,
        metric: new cloudwatch.Metric({
          namespace: "ECS/ContainerInsights",
          metricName: "RunningTaskCount",
          dimensionsMap: {
            ClusterName: cluster.clusterName,
            ServiceName: service.serviceName,
          },
          period: Duration.minutes(1),
          statistic: "Minimum",
        }),
        threshold: 1,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
    }

    for (const [id, logGroup] of [
      ["Web", webLogGroup],
      ["Scheduler", schedulerLogGroup],
    ] as const) {
      new logs.MetricFilter(this, `${id}FailureMetricFilter`, {
        filterPattern: logs.FilterPattern.anyTerm("error", "lease_lost"),
        logGroup,
        metricName: "ApplicationFailures",
        metricNamespace: "Hollowmere",
        metricValue: "1",
      });
    }
    new cloudwatch.Alarm(this, "RepeatedApplicationFailuresAlarm", {
      alarmName: "hollowmere-repeated-application-failures",
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      metric: new cloudwatch.Metric({
        namespace: "Hollowmere",
        metricName: "ApplicationFailures",
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }

  private extendDeployRole(
    role: iam.IRole,
    cluster: ecs.ICluster,
    webService: ecs.IService,
    schedulerService: ecs.IService,
    webRoles: ServiceRoles,
    schedulerRoles: ServiceRoles,
    migrationRoles: ServiceRoles,
  ): void {
    const deployServices = new iam.PolicyStatement({
      sid: "DeployHollowmereServices",
      actions: ["ecs:DescribeServices", "ecs:UpdateService"],
      resources: [webService.serviceArn, schedulerService.serviceArn],
    });
    const runMigration = new iam.PolicyStatement({
      sid: "RunHollowmereMigration",
      actions: ["ecs:RunTask", "ecs:DescribeTasks"],
      resources: ["*"],
      conditions: {
        ArnEquals: { "ecs:cluster": cluster.clusterArn },
      },
    });
    const registerTaskDefinitions = new iam.PolicyStatement({
      sid: "RegisterHollowmereTaskDefinitions",
      actions: ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"],
      resources: ["*"],
    });
    const passTaskRoles = new iam.PolicyStatement({
      sid: "PassHollowmereTaskRoles",
      actions: ["iam:PassRole"],
      conditions: {
        StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
      },
      resources: [
        webRoles.execution.roleArn,
        webRoles.task.roleArn,
        schedulerRoles.execution.roleArn,
        schedulerRoles.task.roleArn,
        migrationRoles.execution.roleArn,
        migrationRoles.task.roleArn,
      ],
    });
    const describeCluster = new iam.PolicyStatement({
      sid: "DescribeHollowmereCluster",
      actions: ["ecs:DescribeClusters"],
      resources: [cluster.clusterArn],
    });
    const policy = new iam.Policy(this, "GitHubRuntimeDeployPolicy", {
      policyName: "hollowmere-runtime-deploy",
      roles: [role],
      statements: [
        deployServices,
        runMigration,
        registerTaskDefinitions,
        passTaskRoles,
        describeCluster,
      ],
    });
    Validations.of(policy).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "ECS task-definition registration and the one-off migration task need wildcard resources where stable ARNs are unavailable; migration execution is constrained to the exact Hollowmere cluster, while service updates and PassRole remain exact-resource scoped.",
    });
  }
}
