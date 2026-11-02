---
title: Exports and the query cache
description: Where export files go, and where query results are kept.
---

## Export files

Export files go in `exports` under the [data directory](/deployment/configuration/#basics) by default. With several instances, the `api` and `worker` roles must share that directory on persistent storage, or you can move exports to object storage.

Setting `export-storage` to `s3` uses AWS S3 or compatible storage, such as RustFS, Ceph RGW or a cloud vendor's object storage, so that no shared volume is needed. Files are still forwarded to the browser by the API. Every download checks permissions and writes an audit record, and presigned links are not used.

| Setting | Meaning |
|---|---|
| `export-storage` | `local` (default, the data directory) or `s3` |
| `s3-endpoint` | The address of compatible storage, such as `https://s3.example.com`. If empty, AWS S3 is used |
| `s3-region` | Default `us-east-1`. Requests are signed for it |
| `s3-bucket` | The bucket, which must be created beforehand |
| `s3-prefix` | A prefix for object keys, for several installations sharing a bucket, such as `prod/` |
| `s3-path-style` | Addresses the bucket as `endpoint/bucket`. Self-hosted RustFS and Ceph usually need it on |
| `s3-access-key-id`, `s3-secret-access-key` | The access keys, set both or neither |

With neither key set, the default credentials of the AWS SDK are used, such as `AWS_ACCESS_KEY_ID` and the other variables, or an IAM role on EKS, ECS or EC2.

Startup checks that the bucket can be reached, and refuses to start if it cannot.

:::caution
Switching storage does not move existing files. Exports made before the switch that have not expired can no longer be downloaded.
:::

The limits of exports, such as the most rows and how long files are kept, are [general settings](/admin/system/#general-settings). The background jobs that run exports are the `worker` role, and `export-workers` sets how many run at once in each process.

## Query cache

Query results are kept in the memory of each instance for 10 minutes by default, and the same query uses the last result. Identical queries running at the same time execute only once. The lifetime is changed in [general settings](/admin/system/#general-settings), and a [data source](/data/datasources/#query-settings) can set its own.

| Setting | Meaning |
|---|---|
| `query-cache` | `memory` (default, each instance caches on its own), `redis` (shared by the instances) or `off` |
| `query-cache-size` | The most memory used with `memory`, such as `256MB` |
| `redis-url` | The Redis to use, such as `rediss://:PASSWORD@host:6379/0` |
| `redis-key-prefix` | The prefix of keys written to Redis, `supabi:` by default |

Use `redis` with several instances. Keep these in mind:

- Redis itself controls the size of the cache: set `maxmemory` on it, with `allkeys-lru` or `volatile-lru` as the eviction policy.
- Redis holds query results, which are business data, so open it only to SupaBI and protect it with a password.
- When Redis is unavailable, queries run as usual without caching, and the log has a warning.

People with different data permissions never share a cached result.
