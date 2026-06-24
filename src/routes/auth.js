import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { v4 as uuid } from 'uuid'
import { User, UserProfile } from '../db/models.js'
import { authRequired, signToken } from '../middleware/auth.js'
import { conflict, validationError, unauthorized } from '../utils/errors.js'
import { formatUser } from '../utils/serializers.js'

const router = Router()

router.post('/register', async (req, res, next) => {
  try {
    const {
      firstName,
      lastName,
      studentId,
      email,
      phone,
      university,
      program,
      level,
      role,
      password,
    } = req.body ?? {}

    if (!firstName || !lastName || !studentId || !email || !university || !program || !level || !role || !password) {
      throw validationError('Missing required registration fields')
    }

    if (!['100', '200', '300', '400'].includes(level)) {
      throw validationError('Invalid academic level')
    }

    if (!['student', 'instructor'].includes(role)) {
      throw validationError('Invalid role')
    }

    if (password.length < 8) {
      throw validationError('Password must be at least 8 characters')
    }

    const existingEmail = await User.findOne({ email: email.toLowerCase() }).lean()
    if (existingEmail) {
      throw conflict('Email already registered')
    }

    const existingStudentId = await User.findOne({ student_id: studentId }).lean()
    if (existingStudentId) {
      throw conflict('Student ID already registered')
    }

    const now = new Date().toISOString()
    const userId = uuid()
    const passwordHash = bcrypt.hashSync(password, 10)

    await User.create({
      id: userId,
      email: email.toLowerCase(),
      password_hash: passwordHash,
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      student_id: studentId.trim(),
      phone: phone?.trim() || null,
      university,
      program,
      level,
      role,
      created_at: now,
      updated_at: now,
    })

    await UserProfile.create({
      user_id: userId,
      full_name: `${firstName} ${lastName}`.trim(),
      student_role: program,
      primary_university: university,
      location: '',
      updated_at: now,
    })

    const user = await User.findOne({ id: userId }).lean()
    const token = signToken(userId)

    res.status(201).json({ token, user: formatUser(user) })
  } catch (error) {
    next(error)
  }
})

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {}
    if (!email || !password) {
      throw validationError('Email and password are required')
    }

    const user = await User.findOne({ email: email.toLowerCase() }).lean()
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      throw unauthorized('Invalid email or password')
    }

    const token = signToken(user.id)
    res.json({ token, user: formatUser(user) })
  } catch (error) {
    next(error)
  }
})

router.get('/me', authRequired, (req, res) => {
  res.json(req.userFormatted)
})

export default router
