import { AppError } from '../utils/errors.js'

export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err)
    return
  }

  if (err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Profile photo too large (max 5MB)' },
    })
    return
  }
  if (err?.message?.includes('Profile photo must be')) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: err.message },
    })
    return
  }

  const status = err.status || 500
  const code = err.code || 'INTERNAL_ERROR'
  const message = err.message || 'Internal server error'

  if (!(err instanceof AppError) && status === 500) {
    console.error(err)
  }

  res.status(status).json({
    error: {
      code,
      message,
      ...(err.details ? { details: err.details } : {}),
    },
  })
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  })
}
