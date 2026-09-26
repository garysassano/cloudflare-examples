# wrangler-upload-events-logger

Wrangler app that generates a log upon uploading a file to an R2 bucket.

### Related Apps

- [cdktn/upload-events-logger](../../cdktn/upload-events-logger) - Built with CDKTN instead of Wrangler.

## Architecture Diagram

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./src/assets/arch-diagram-dark.svg">
  <img alt="Architecture Diagram" src="./src/assets/arch-diagram.svg">
</picture>

## Prerequisites

- **_Cloudflare:_**
  - Must have set the `CLOUDFLARE_API_TOKEN` variable in your local environment, with the `Workers Scripts:Edit`, `Queues:Edit`, `Workers R2 Storage:Edit` and `Account Settings:Read` permissions.
- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages Node and pnpm.

## Installation

```sh
mise install
pnpm install
```

## Deployment

Create R2 buckets:

```sh
pnpm wrangler r2 bucket create upload-bucket
pnpm wrangler r2 bucket create log-bucket
```

Create queue:

```sh
pnpm wrangler queues create upload-events
```

Create worker:

```sh
pnpm run deploy
```

Enable R2 event notifications:

```sh
pnpm wrangler r2 bucket notification create upload-bucket --event-type object-create --queue upload-events
```

## Usage

1. Upload a file to `upload-bucket` from the Cloudflare dashboard.

2. After the upload is complete, logs will appear in `log-bucket`.

## Cleanup

```sh
pnpm wrangler delete
```
