#!/usr/bin/env node

import { App, Tags, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";

import { HollowmereRegistryStack } from "../lib/registry-stack.ts";
import { HollowmereRuntimeStack } from "../lib/runtime-stack.ts";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const environment = account === undefined
  ? { region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" }
  : {
      account,
      region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
    };

const registryStack = new HollowmereRegistryStack(
  app,
  "HollowmereRegistryStack",
  {
    env: environment,
    github: {
      owner: "nnetraga97",
      ownerId: "101073419",
      repository: "hollowmere",
      repositoryId: "1311493425",
      branch: "main",
      environment: "production",
    },
  },
);

Tags.of(registryStack).add("Application", "Hollowmere");
Tags.of(registryStack).add("ManagedBy", "AWS-CDK");

const runtimeStack = new HollowmereRuntimeStack(app, "HollowmereRuntimeStack", {
  env: environment,
  githubDeployRole: registryStack.githubDeployRole,
  repositories: {
    scheduler: registryStack.schedulerRepository,
    web: registryStack.webRepository,
  },
  terminationProtection: true,
});
runtimeStack.addStackDependency(registryStack);
Tags.of(runtimeStack).add("Application", "Hollowmere");
Tags.of(runtimeStack).add("ManagedBy", "AWS-CDK");

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

app.synth();
