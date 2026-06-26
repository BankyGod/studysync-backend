import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password_hash: { type: String, required: true },
    first_name: { type: String, required: true },
    last_name: { type: String, required: true },
    student_id: { type: String, required: true, unique: true },
    phone: { type: String, default: null },
    university: { type: String, required: true },
    program: { type: String, required: true },
    level: { type: String, enum: ['100', '200', '300', '400'], required: true },
    role: { type: String, enum: ['student', 'instructor'], required: true },
    created_at: { type: String, required: true },
    updated_at: { type: String, required: true },
  },
  { collection: 'users', versionKey: false },
)

const userProfileSchema = new mongoose.Schema(
  {
    user_id: { type: String, required: true, unique: true },
    full_name: { type: String, required: true },
    student_role: { type: String, default: '' },
    primary_university: { type: String, default: '' },
    secondary_university: { type: String, default: null },
    location: { type: String, default: '' },
    avatar_storage_key: { type: String, default: null },
    avatar_mime_type: { type: String, default: null },
    updated_at: { type: String, required: true },
  },
  { collection: 'user_profiles', versionKey: false },
)

const onboardingProfileSchema = new mongoose.Schema(
  {
    user_id: { type: String, required: true, unique: true },
    learning_style: { type: String, enum: ['visual', 'auditory', 'reading', 'kinesthetic'], required: true },
    availability: { type: String, required: true },
    study_preferences: { type: String, required: true },
    completed_at: { type: String, default: null },
    saved_at: { type: String, required: true },
  },
  { collection: 'onboarding_profiles', versionKey: false },
)

const userCourseSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    user_id: { type: String, required: true, index: true },
    subject: { type: String, required: true },
    course_number: { type: String, required: true },
    is_primary: { type: Number, default: 0 },
  },
  { collection: 'user_courses', versionKey: false },
)

const cohortSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    term: { type: String, default: null },
    created_at: { type: String, required: true },
  },
  { collection: 'cohorts', versionKey: false },
)

const studyGroupSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    subject: { type: String, required: true },
    course_number: { type: String, required: true },
    cohort_id: { type: String, default: null },
    created_at: { type: String, required: true },
  },
  { collection: 'study_groups', versionKey: false },
)

const groupMemberSchema = new mongoose.Schema(
  {
    group_id: { type: String, required: true },
    user_id: { type: String, required: true },
    joined_at: { type: String, required: true },
    initials: { type: String, required: true },
    avatar_color: { type: String, required: true },
  },
  { collection: 'group_members', versionKey: false },
)
groupMemberSchema.index({ group_id: 1, user_id: 1 }, { unique: true })
groupMemberSchema.index({ user_id: 1 })

const taskSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    group_id: { type: String, required: true, index: true },
    title: { type: String, required: true },
    status: { type: String, enum: ['todo', 'in_progress', 'completed'], required: true },
    variant: { type: String, enum: ['default', 'highlight', 'completed'], default: 'default' },
    due_date: { type: String, default: null },
    completed_at: { type: String, default: null },
    assignee_id: { type: String, default: null },
    position: { type: Number, default: 0 },
    created_at: { type: String, required: true },
  },
  { collection: 'tasks', versionKey: false },
)
taskSchema.index({ group_id: 1, status: 1 })

const storedFileSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    group_id: { type: String, default: null, index: true },
    uploaded_by_id: { type: String, required: true },
    file_name: { type: String, required: true },
    file_size: { type: Number, required: true },
    file_type: { type: String, required: true },
    storage_key: { type: String, required: true },
    purpose: { type: String, enum: ['shared', 'chat_attachment', 'voice'], required: true },
    uploaded_at: { type: String, required: true },
  },
  { collection: 'stored_files', versionKey: false },
)

const messageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    group_id: { type: String, required: true, index: true },
    sender_id: { type: String, required: true },
    type: { type: String, enum: ['text', 'attachment', 'voice'], required: true },
    content: { type: String, required: true },
    file_id: { type: String, default: null },
    voice_duration_sec: { type: Number, default: null },
    sent_at: { type: String, required: true },
  },
  { collection: 'messages', versionKey: false },
)
messageSchema.index({ group_id: 1, sent_at: 1 })

const scheduledSessionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    group_id: { type: String, required: true, index: true },
    title: { type: String, required: true },
    date: { type: String, required: true },
    start_time: { type: String, required: true },
    end_time: { type: String, required: true },
    meeting_type: { type: String, required: true },
    agenda: { type: String, default: null },
    created_by_id: { type: String, default: null },
    created_at: { type: String, required: true },
  },
  { collection: 'scheduled_sessions', versionKey: false },
)

const matchingJobSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    user_id: { type: String, required: true, index: true },
    course_subject: { type: String, required: true },
    course_number: { type: String, required: true },
    status: { type: String, enum: ['pending', 'running', 'waiting', 'completed', 'failed'], required: true },
    progress: { type: Number, default: 0 },
    current_step: { type: String, default: null },
    result_group_id: { type: String, default: null },
    error_message: { type: String, default: null },
    error_code: { type: String, default: null },
    created_at: { type: String, required: true },
    completed_at: { type: String, default: null },
  },
  { collection: 'matching_jobs', versionKey: false },
)

export const User = mongoose.model('User', userSchema)
export const UserProfile = mongoose.model('UserProfile', userProfileSchema)
export const OnboardingProfile = mongoose.model('OnboardingProfile', onboardingProfileSchema)
export const UserCourse = mongoose.model('UserCourse', userCourseSchema)
export const Cohort = mongoose.model('Cohort', cohortSchema)
export const StudyGroup = mongoose.model('StudyGroup', studyGroupSchema)
export const GroupMember = mongoose.model('GroupMember', groupMemberSchema)
export const Task = mongoose.model('Task', taskSchema)
export const StoredFile = mongoose.model('StoredFile', storedFileSchema)
export const Message = mongoose.model('Message', messageSchema)
export const ScheduledSession = mongoose.model('ScheduledSession', scheduledSessionSchema)
export const MatchingJob = mongoose.model('MatchingJob', matchingJobSchema)
