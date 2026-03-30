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

## 検証項目

- Presigned URL の GET/PUT が CloudFront 経由で動作するか
- マルチパートアップロード（各パートの PUT + ETag 取得）が CloudFront 経由で動作するか
- CORS（`Access-Control-Expose-Headers: ETag`）が CloudFront 経由で正しく返るか
- OAC あり（署名なし）と OAC なし（Presigned URL）のビヘイビアが同一ディストリビューションで共存できるか

## 先行検証で判明した事実

- **OAC + Presigned URL は併用不可**（`Only one auth mechanism allowed`）
- OACなし + Presigned URL でリバースプロキシは正常動作する（GET で確認済み）

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
