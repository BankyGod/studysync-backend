const uploadBuckets = new Map()

export function createUploadRateLimiter({ windowMs = 60_000, maxUploads = 20 } = {}) {
  return function uploadRateLimit(req, res, next) {
    const key = `${req.user?.id ?? 'anon'}:${req.group?.id ?? req.params.groupId ?? 'unknown'}`
    const now = Date.now()
    const bucket = uploadBuckets.get(key) ?? { count: 0, resetAt: now + windowMs }

    if (now > bucket.resetAt) {
      bucket.count = 0
      bucket.resetAt = now + windowMs
    }

    bucket.count += 1
    uploadBuckets.set(key, bucket)

    if (bucket.count > maxUploads) {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many uploads. Please wait a moment and try again.',
        },
      })
      return
    }

    next()
  }
}
