import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Validations,
  type StackProps,
} from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

export interface GitHubIdentity {
  readonly owner: string;
  readonly ownerId: string;
  readonly repository: string;
  readonly repositoryId: string;
  readonly branch: string;
  readonly environment: string;
}

export interface HollowmereRegistryStackProps extends StackProps {
  readonly github: GitHubIdentity;
}

const DEPLOYED_IMAGE_LIMIT = 9_999;
const RECENT_COMMIT_IMAGE_LIMIT = 20;

export class HollowmereRegistryStack extends Stack {
  public readonly webRepository: ecr.Repository;
  public readonly schedulerRepository: ecr.Repository;
  public readonly githubDeployRole: iam.Role;

  public constructor(
    scope: Construct,
    id: string,
    props: HollowmereRegistryStackProps,
  ) {
    super(scope, id, props);

    this.webRepository = this.createRepository("WebRepository", "hollowmere-web");
    this.schedulerRepository = this.createRepository(
      "SchedulerRepository",
      "hollowmere-scheduler",
    );

    const githubProvider = new iam.OidcProviderNative(this, "GitHubProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const subject =
      `repo:${props.github.owner}@${props.github.ownerId}/` +
      `${props.github.repository}@${props.github.repositoryId}:` +
      `environment:${props.github.environment}`;

    this.githubDeployRole = new iam.Role(this, "GitHubDeployRole", {
      roleName: "hollowmere-github-deploy",
      description:
        "Pushes immutable Hollowmere images from the protected GitHub production environment.",
      assumedBy: new iam.WebIdentityPrincipal(
        githubProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": subject,
            "token.actions.githubusercontent.com:repository_id":
              props.github.repositoryId,
            "token.actions.githubusercontent.com:repository_owner_id":
              props.github.ownerId,
            "token.actions.githubusercontent.com:ref":
              `refs/heads/${props.github.branch}`,
            "token.actions.githubusercontent.com:environment":
              props.github.environment,
          },
        },
      ),
    });

    this.githubDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "GetEcrAuthorizationToken",
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );
    this.githubDeployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PushHollowmereImages",
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ],
        resources: [
          this.webRepository.repositoryArn,
          this.schedulerRepository.repositoryArn,
        ],
      }),
    );

    Validations.of(this.githubDeployRole).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "ecr:GetAuthorizationToken does not support repository-scoped resources; every image upload action is restricted to the two exact Hollowmere repository ARNs.",
    });

    new CfnOutput(this, "WebRepositoryUri", {
      value: this.webRepository.repositoryUri,
    });
    new CfnOutput(this, "SchedulerRepositoryUri", {
      value: this.schedulerRepository.repositoryUri,
    });
    new CfnOutput(this, "GitHubDeployRoleArn", {
      value: this.githubDeployRole.roleArn,
    });
  }

  private createRepository(id: string, repositoryName: string): ecr.Repository {
    const repository = new ecr.Repository(this, id, {
      repositoryName,
      encryption: ecr.RepositoryEncryption.AES_256,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      emptyOnDelete: false,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    repository.addLifecycleRule({
      description:
        "Protect deployed-* tags from the 20-image commit retention rule.",
      rulePriority: 1,
      tagPrefixList: ["deployed-"],
      maxImageCount: DEPLOYED_IMAGE_LIMIT,
    });
    repository.addLifecycleRule({
      description: "Retain the 20 most recent sha-* commit images.",
      rulePriority: 2,
      tagPrefixList: ["sha-"],
      maxImageCount: RECENT_COMMIT_IMAGE_LIMIT,
    });
    repository.addLifecycleRule({
      description: "Retain the 20 most recent migration-sha-* images.",
      rulePriority: 3,
      tagPrefixList: ["migration-sha-"],
      maxImageCount: RECENT_COMMIT_IMAGE_LIMIT,
    });
    repository.addLifecycleRule({
      description: "Remove untagged upload remnants after seven days.",
      rulePriority: 4,
      tagStatus: ecr.TagStatus.UNTAGGED,
      maxImageAge: Duration.days(7),
    });

    return repository;
  }
}
