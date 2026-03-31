import * as cdk from 'aws-cdk-lib/core';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * CloudFront リバースプロキシ検証用スタック
 *
 * S3 Presigned URL + CloudFrontプロキシの動作検証を行うための一時的なスタック。
 * 検証完了後に `cdk destroy` で削除する。
 */
export class ReverseProxyVerificationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- S3バケット ---

    const uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedOrigins: ['*'],
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(1),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
    });

    const downloadBucket = new s3.Bucket(this, 'DownloadBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedOrigins: ['*'],
          allowedMethods: [s3.HttpMethods.GET],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(1),
        },
      ],
    });

    // --- CloudFront Function ---

    const rewriteFunction = new cloudfront.Function(
      this,
      'RewriteDataPresignedPath',
      {
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  request.uri = request.uri.replace('/data-presigned/', '/data/');
  return request;
}
        `),
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        comment: 'Rewrite /data-presigned/* to /data/* for S3 key mapping',
      }
    );

    // --- CloudFrontディストリビューション ---

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Reverse Proxy Verification - DELETE AFTER TESTING',

      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(downloadBucket),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },

      additionalBehaviors: {
        '/upload/*': {
          origin: origins.S3BucketOrigin.withBucketDefaults(uploadBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: false,
        },

        '/data-presigned/*': {
          origin: origins.S3BucketOrigin.withBucketDefaults(downloadBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [
            {
              function: rewriteFunction,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },

        '/data/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(
            downloadBucket
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        },
      },
    });

    // --- Outputs ---

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFrontドメイン名（検証用URLのベース）',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFrontディストリビューションID',
    });

    new cdk.CfnOutput(this, 'UploadBucketName', {
      value: uploadBucket.bucketName,
      description: 'アップロード用バケット名（Presigned URL生成に使用）',
    });

    new cdk.CfnOutput(this, 'DownloadBucketName', {
      value: downloadBucket.bucketName,
      description: 'ダウンロード用バケット名（Presigned URL生成に使用）',
    });
  }
}
