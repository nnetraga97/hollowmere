import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";

import { HollowmereRegistryStack } from "../lib/registry-stack.ts";

const GITHUB = {
  owner: "nnetraga97",
  ownerId: "101073419",
  repository: "hollowmere",
  repositoryId: "1311493425",
  branch: "main",
  environment: "production",
} as const;

function createStack(options: { readonly nag?: boolean } = {}) {
  const app = new App();
  const stack = new HollowmereRegistryStack(app, "TestRegistryStack", {
    env: { account: "123456789012", region: "us-east-1" },
    github: GITHUB,
  });
  const assembly = app.synth();
  const nagReport = options.nag === true
    ? new AwsSolutionsChecks(app, { verbose: true }).validateScope(app)
    : undefined;
  return {
    assembly,
    nagReport,
    stack,
    template: Template.fromStack(stack),
  };
}

describe("HollowmereRegistryStack", () => {
  it("creates two retained, encrypted, immutable, scan-on-push repositories", () => {
    const { template } = createStack();

    template.resourceCountIs("AWS::ECR::Repository", 2);
    template.hasResource("AWS::ECR::Repository", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        // ECR's omitted encryption property is the service-default AES-256 mode.
        EncryptionConfiguration: Match.absent(),
        ImageScanningConfiguration: { ScanOnPush: true },
        ImageTagMutability: "IMMUTABLE",
        RepositoryName: "hollowmere-web",
      },
    });
    template.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: "hollowmere-scheduler",
    });
  });

  it("retains 20 sha images while deployed tags take lifecycle precedence", () => {
    const { template } = createStack();

    template.allResourcesProperties("AWS::ECR::Repository", {
      LifecyclePolicy: {
        LifecyclePolicyText: Match.serializedJson({
          rules: [
            {
              rulePriority: 1,
              description:
                "Protect deployed-* tags from the 20-image commit retention rule.",
              selection: {
                tagStatus: "tagged",
                tagPrefixList: ["deployed-"],
                countType: "imageCountMoreThan",
                countNumber: 9999,
              },
              action: { type: "expire" },
            },
            {
              rulePriority: 2,
              description: "Retain the 20 most recent sha-* commit images.",
              selection: {
                tagStatus: "tagged",
                tagPrefixList: ["sha-"],
                countType: "imageCountMoreThan",
                countNumber: 20,
              },
              action: { type: "expire" },
            },
            {
              rulePriority: 3,
              description: "Retain the 20 most recent migration-sha-* images.",
              selection: {
                tagStatus: "tagged",
                tagPrefixList: ["migration-sha-"],
                countType: "imageCountMoreThan",
                countNumber: 20,
              },
              action: { type: "expire" },
            },
            Match.anyValue(),
          ],
        }),
      },
    });
  });

  it("requires the immutable repository subject, main ref, and production environment", () => {
    const { template } = createStack();

    template.hasResource("AWS::IAM::OIDCProvider", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        ClientIdList: ["sts.amazonaws.com"],
        Url: "https://token.actions.githubusercontent.com",
      },
    });

    template.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "hollowmere-github-deploy",
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub":
                  "repo:nnetraga97@101073419/hollowmere@1311493425:environment:production",
                "token.actions.githubusercontent.com:repository_id": "1311493425",
                "token.actions.githubusercontent.com:repository_owner_id": "101073419",
                "token.actions.githubusercontent.com:ref": "refs/heads/main",
                "token.actions.githubusercontent.com:environment": "production",
              },
            },
          }),
        ],
      },
    });
  });

  it("grants image uploads only to the two exact repositories", () => {
    const { template } = createStack();

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "GetEcrAuthorizationToken",
            Action: "ecr:GetAuthorizationToken",
            Resource: "*",
          }),
          Match.objectLike({
            Sid: "PushHollowmereImages",
            Action: Match.arrayWith(["ecr:PutImage"]),
            Resource: [
              Match.objectLike({
                "Fn::GetAtt": [Match.stringLikeRegexp("WebRepository"), "Arn"],
              }),
              Match.objectLike({
                "Fn::GetAtt": [
                  Match.stringLikeRegexp("SchedulerRepository"),
                  "Arn",
                ],
              }),
            ],
          }),
        ]),
      },
    });
  });

  it("passes AwsSolutions checks with only the documented token suppression", () => {
    const { nagReport } = createStack({ nag: true });

    assert.equal(nagReport?.success, true);
    assert.deepEqual(nagReport?.violations, []);
  });
});
