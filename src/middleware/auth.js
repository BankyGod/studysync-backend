import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { User, StudyGroup, GroupMember, UserProfile } from '../db/models.js'
import { unauthorized, forbidden, notFound } from '../utils/errors.js'
import { formatUserWithAvatar, requestAbsoluteBase } from '../utils/profileAvatar.js'
import { userHasAnyPermission } from '../services/staffPermissions.js'


export function signToken(userId) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn })
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret)
}

export async function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw unauthorized('Missing or invalid authorization header')
    }

    const token = header.slice(7)
    const payload = verifyToken(token)
    const user = await User.findOne({ id: payload.sub }).lean()

    if (!user) {
      throw unauthorized('User not found')
    }

    req.user = user
    req.userFormatted = await formatUserWithAvatar(user, {
      absoluteBase: requestAbsoluteBase(req),
    })
    next()
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      next(unauthorized('Invalid or expired token'))
      return
    }
    next(error)
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(forbidden('Insufficient permissions'))
      return
    }
    next()
  }
}

/** Require at least one of the given staff permissions (based on staff_role). */
export function requireStaffPermission(...permissions) {
  return (req, res, next) => {
    if (!req.user || !['admin', 'instructor'].includes(req.user.role)) {
      next(forbidden('Staff access required'))
      return
    }
    if (!userHasAnyPermission(req.user, ...permissions)) {
      next(forbidden('Insufficient staff permissions'))
      return
    }
    next()
  }
}

export async function getGroupBySlug(slug) {
  return StudyGroup.findOne({ slug }).lean()
}

export async function requireGroupMember(req, res, next) {
  try {
    const group = await getGroupBySlug(req.params.groupId)
    if (!group) {
      next(notFound('Workspace not found'))
      return
    }

    const membership = await GroupMember.findOne({ group_id: group.id, user_id: req.user.id }).lean()

    if (!membership && !['instructor', 'admin'].includes(req.user.role)) {
      next(forbidden('You are not a member of this workspace'))
      return
    }

    req.group = group
    req.membership = membership || null
    next()
  } catch (error) {
    next(error)
  }
}
