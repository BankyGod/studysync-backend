export class AppError extends Error {
  constructor(status, code, message, details = null) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export function validationError(message, details = null) {
  return new AppError(400, 'VALIDATION_ERROR', message, details)
}

export function notFound(message = 'Resource not found') {
  return new AppError(404, 'NOT_FOUND', message)
}

export function forbidden(message = 'Forbidden') {
  return new AppError(403, 'FORBIDDEN', message)
}

export function unauthorized(message = 'Unauthorized') {
  return new AppError(401, 'UNAUTHORIZED', message)
}

export function conflict(message) {
  return new AppError(409, 'CONFLICT', message)
}

export function alreadyInGroup(message = 'You are already in a study group for this course.') {
  return new AppError(409, 'ALREADY_IN_GROUP', message)
}

export function moveBackApprovalRequired(message, details = null) {
  return new AppError(409, 'MOVE_BACK_APPROVAL_REQUIRED', message, details)
}

export function regressRequiresApproval(message, details = null) {
  return new AppError(409, 'REGRESS_REQUIRES_APPROVAL', message, details)
}
