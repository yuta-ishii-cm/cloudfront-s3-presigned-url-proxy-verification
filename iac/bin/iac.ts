#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ReverseProxyVerificationStack } from '../lib/reverse-proxy-verification-stack';

const app = new cdk.App();

new ReverseProxyVerificationStack(app, 'cf-reverse-proxy-verification', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'ap-northeast-1',
  },
});
