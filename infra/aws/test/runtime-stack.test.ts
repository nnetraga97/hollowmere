import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";

import { HollowmereRegistryStack } from "../lib/registry-stack.ts";
import { HollowmereRuntimeStack } from "../lib/runtime-stack.ts";

interface SynthResource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
}

const GITHUB = {
  owner: "nnetraga97",
  ownerId: "101073419",
  repository: "hollowmere",
  repositoryId: "1311493425",
  branch: "main",
  environment: "production",
} as const;

function createRuntime() {
  const app = new App({
    context: { "@aws-cdk/core:defaultCrossStackReferences": "strong" },
  });
  const registry = new HollowmereRegistryStack(app, "TestRegistryStack", {
    env: { account: "123456789012", region: "us-east-1" },
    github: GITHUB,
  });
  const runtime = new HollowmereRuntimeStack(app, "TestRuntimeStack", {
    env: { account: "123456789012", region: "us-east-1" },
    githubDeployRole: registry.githubDeployRole,
    repositories: {
      scheduler: registry.schedulerRepository,
      web: registry.webRepository,
    },
    terminationProtection: true,
  });
  runtime.addStackDependency(registry);
  const assembly = app.synth();
  const template = Template.fromStack(runtime);
  const resources = template.toJSON().Resources as Record<string, SynthResource>;

  return { app, assembly, resources, runtime, template };
}

function resourcesOf(
  resources: Record<string, SynthResource>,
  type: string,
): SynthResource[] {
  return Object.values(resources).filter((resource) => resource.Type === type);
}

function property(resource: SynthResource, key: string): unknown {
  return resource.Properties?.[key];
}

describe("HollowmereRuntimeStack", () => {
  it("creates a two-AZ public-subnet VPC and an observable ECS cluster", () => {
    const { runtime, template } = createRuntime();

    assert.equal(runtime.terminationProtection, true);
    template.resourceCountIs("AWS::EC2::VPC", 1);
    template.resourceCountIs("AWS::EC2::Subnet", 2);
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.allResourcesProperties("AWS::EC2::Subnet", {
      MapPublicIpOnLaunch: true,
    });
    template.hasResourceProperties("AWS::ECS::Cluster", {
      ClusterName: "hollowmere",
      ClusterSettings: [{ Name: "containerInsights", Value: "enabled" }],
    });
  });

  it("uses separate valid Fargate task sizes and dormant Bedrock configuration", () => {
    const { resources, template } = createRuntime();

    template.resourceCountIs("AWS::ECS::TaskDefinition", 3);
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "512",
      Family: "hollowmere-web",
      Memory: "1024",
      NetworkMode: "awsvpc",
      RequiresCompatibilities: ["FARGATE"],
      RuntimePlatform: {
        CpuArchitecture: "X86_64",
        OperatingSystemFamily: "LINUX",
      },
      ContainerDefinitions: [
        Match.objectLike({
          LogConfiguration: Match.objectLike({
            LogDriver: "awslogs",
            Options: Match.objectLike({ mode: "blocking" }),
          }),
          Name: "web",
          StopTimeout: 60,
        }),
      ],
    });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "1024",
      Family: "hollowmere-scheduler",
      Memory: "2048",
      ContainerDefinitions: [
        Match.objectLike({ Name: "scheduler", StopTimeout: 120 }),
      ],
    });
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Family: "hollowmere-migration",
      ContainerDefinitions: [
        Match.objectLike({
          Command: ["npm", "run", "db:migrate"],
          Name: "migration",
        }),
      ],
    });

    const serializedTasks = JSON.stringify(
      resourcesOf(resources, "AWS::ECS::TaskDefinition"),
    );
    assert.match(serializedTasks, /"Name":"INFERENCE_MODE","Value":"world"/);
    assert.match(serializedTasks, /"Name":"BEDROCK_ENABLED","Value":"false"/);
    assert.match(serializedTasks, /"Name":"BEDROCK_SONNET_REASONING_PROFILE"/);
    assert.match(serializedTasks, /"Name":"BUILD_REVISION","Value":\{"Ref":"BuildRevision"\}/);
    assert.doesNotMatch(serializedTasks, /AWS_ACCESS_KEY_ID/);
    assert.doesNotMatch(serializedTasks, /AZURE_OPENAI_API_KEY","Value":/);
    assert.match(serializedTasks, /DATABASE_MIGRATOR_URL/);
  });

  it("deploys separate rolling services in public subnets without scheduler ingress", () => {
    const { resources, template } = createRuntime();

    template.resourceCountIs("AWS::ECS::Service", 2);
    template.hasResourceProperties("AWS::ECS::Service", {
      ServiceName: "hollowmere-web",
      DesiredCount: 1,
      HealthCheckGracePeriodSeconds: 60,
      PlatformVersion: "LATEST",
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MaximumPercent: 200,
        MinimumHealthyPercent: 100,
      }),
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "ENABLED" }),
      },
    });
    template.hasResourceProperties("AWS::ECS::Service", {
      ServiceName: "hollowmere-scheduler",
      DesiredCount: 1,
      PlatformVersion: "LATEST",
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MaximumPercent: 100,
        MinimumHealthyPercent: 0,
      }),
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "ENABLED" }),
      },
    });

    const ingress = JSON.stringify([
      ...resourcesOf(resources, "AWS::EC2::SecurityGroup"),
      ...resourcesOf(resources, "AWS::EC2::SecurityGroupIngress"),
    ]);
    assert.doesNotMatch(ingress, /SchedulerSecurityGroup/);
  });

  it("terminates TLS at the ALB and uses the exact health contract", () => {
    const { template } = createRuntime();

    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Scheme: "internet-facing",
      Type: "application",
      LoadBalancerAttributes: Match.arrayWith([
        { Key: "deletion_protection.enabled", Value: "true" },
        { Key: "routing.http.drop_invalid_header_fields.enabled", Value: "true" },
      ]),
    });
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 2);
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 80,
      Protocol: "HTTP",
      DefaultActions: [
        Match.objectLike({
          RedirectConfig: Match.objectLike({
            Port: "443",
            Protocol: "HTTPS",
            StatusCode: "HTTP_301",
          }),
          Type: "redirect",
        }),
      ],
    });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "HTTPS",
      Certificates: [{ CertificateArn: { Ref: "CertificateArn" } }],
    });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/api/health",
      Port: 3000,
      Protocol: "HTTP",
      TargetGroupAttributes: Match.arrayWith([
        { Key: "deregistration_delay.timeout_seconds", Value: "30" },
      ]),
      TargetType: "ip",
    });
    template.resourceCountIs("AWS::Route53::RecordSet", 1);
  });

  it("retains 30-day logs, injects named secrets, and creates four alarms", () => {
    const { resources, template } = createRuntime();

    template.resourceCountIs("AWS::Logs::LogGroup", 3);
    template.allResources("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({ RetentionInDays: 30 }),
    });
    template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
    template.resourceCountIs("AWS::Logs::MetricFilter", 2);

    const taskDefinitions = resourcesOf(resources, "AWS::ECS::TaskDefinition");
    const webTask = taskDefinitions.find(
      (resource) => property(resource, "Family") === "hollowmere-web",
    );
    assert.ok(webTask);
    const webJson = JSON.stringify(webTask);
    for (const name of [
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_ENDPOINT",
      "DATABASE_CA_CERT_BASE64",
      "DATABASE_URL",
      "SESSION_SECRET",
    ]) {
      assert.match(webJson, new RegExp(`\\"Name\\":\\"${name}\\"`));
    }
  });

  it("separates execution and task roles and avoids wildcard Bedrock resources", () => {
    const { resources, template } = createRuntime();

    template.resourceCountIs("AWS::IAM::Role", 7);
    for (const roleName of [
      "hollowmere-web-execution",
      "hollowmere-web-task",
      "hollowmere-scheduler-execution",
      "hollowmere-scheduler-task",
      "hollowmere-migration-execution",
      "hollowmere-migration-task",
    ]) {
      template.hasResourceProperties("AWS::IAM::Role", { RoleName: roleName });
    }

    const policies = resourcesOf(resources, "AWS::IAM::Policy");
    const bedrockPolicies = policies.filter((resource) =>
      JSON.stringify(resource).includes("bedrock:InvokeModel"),
    );
    assert.equal(bedrockPolicies.length, 2);
    for (const policy of bedrockPolicies) {
      const json = JSON.stringify(policy);
      assert.doesNotMatch(json, /"Resource":"\*"/);
      assert.doesNotMatch(json, /AmazonBedrockFullAccess/);
    }

    const deployPolicy = policies.find(
      (resource) => property(resource, "PolicyName") === "hollowmere-runtime-deploy",
    );
    assert.ok(deployPolicy);
    const deployJson = JSON.stringify(deployPolicy);
    assert.match(deployJson, /ecs:RegisterTaskDefinition/);
    assert.match(deployJson, /ecs:RunTask/);
    assert.match(deployJson, /ecs:DescribeTasks/);
    assert.match(deployJson, /MigrationExecutionRole/);
    assert.match(deployJson, /MigrationTaskRole/);
    assert.match(deployJson, /iam:PassRole/);
    assert.match(deployJson, /ecs-tasks\.amazonaws\.com/);
    assert.doesNotMatch(deployJson, /AdministratorAccess/);
  });

  it("reports only the four documented AwsSolutions acknowledgements", () => {
    const { app } = createRuntime();
    const report = new AwsSolutionsChecks(app, { verbose: true }).validateScope(app);
    const ruleNames = report.violations
      .map((violation) => violation.ruleName)
      .sort();

    assert.equal(report.success, false);
    assert.deepEqual(ruleNames, [
      "AwsSolutions-EC23",
      "AwsSolutions-ECS2",
      "AwsSolutions-ELB2",
      "AwsSolutions-VPC7",
    ]);
  });
});
