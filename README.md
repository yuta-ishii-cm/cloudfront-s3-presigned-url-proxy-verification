# cloudfront-s3-presigned-url-proxy-verification

CloudFront を S3 Presigned URL のリバースプロキシとして使用する構成の検証環境。

## 何を検証するか

S3 Presigned URL のドメインをカスタムドメインに差し替え、CloudFront 経由でS3にアクセスできるかを検証する。
ファイアウォールで S3 ドメイン（`s3.amazonaws.com`）がブロックされる環境への対策。

```
クライアント → https://{CloudFront}/upload/{key}?X-Amz-Signature=xxx
                  ↓ CloudFront（リバースプロキシ）
               https://{bucket}.s3.amazonaws.com/upload/{key}?X-Amz-Signature=xxx
```

## 先行検証で判明した事実

- **OAC + Presigned URL は併用不可**（`Only one auth mechanism allowed`）
- OACなし + Presigned URL でリバースプロキシは正常動作する

## 構成

| ビヘイビア | 用途 | OAC |
|-----------|------|-----|
| `/upload/*` | Presigned URL で PUT | なし |
| `/data-presigned/*` | Presigned URL で GET | なし |
| `/data/*` | 署名なしで GET（OAC認証） | あり |

## セットアップ

```bash
pnpm install
npx cdk bootstrap --profile {PROFILE}
npx cdk deploy --profile {PROFILE}
```

## 検証手順

詳細は [構築指示書](docs/setup.md) を参照。

## クリーンアップ

```bash
npx cdk destroy --profile {PROFILE}
```
