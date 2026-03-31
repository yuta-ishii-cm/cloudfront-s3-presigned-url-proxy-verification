import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const client = new S3Client({ region: 'ap-northeast-1' });
const bucketName = process.argv[2];
const key = 'upload/test-multipart.txt';

const { UploadId } = await client.send(
  new CreateMultipartUploadCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: 'text/plain',
  })
);

console.log(`UploadId: ${UploadId}`);
console.log(`Key: ${key}`);

for (const partNumber of [1, 2]) {
  const url = await getSignedUrl(
    client,
    new UploadPartCommand({
      Bucket: bucketName,
      Key: key,
      PartNumber: partNumber,
      UploadId,
    }),
    { expiresIn: 3600 }
  );
  console.log(`Part ${partNumber}: ${url}`);
}
