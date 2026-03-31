import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const client = new S3Client({ region: 'ap-northeast-1' });

const bucketName = process.argv[2];
const key = process.argv[3] ?? 'upload/test-put.txt';

const command = new PutObjectCommand({
  Bucket: bucketName,
  Key: key,
  ContentType: 'text/plain',
});

const url = await getSignedUrl(client, command, { expiresIn: 3600 });
console.log(url);
