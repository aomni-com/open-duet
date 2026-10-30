export { ComposeBar } from './compose-bar/compose-bar'
export { AttachmentCard, attachmentPreview } from './compose-bar/compose-bar-attachment'

// The tag grammar is public: a sent message has to render the same tag back as
// the same chip, and a second parser at that end is the divergence the shared
// grammar exists to prevent.
export {
  findMentionTagStart,
  matchMentionTag,
  renderMentionTag,
  type MentionAttributes,
  type MentionTagSpec,
} from './compose-bar/compose-bar-mention'
export { SKILL_TAG } from './compose-bar/compose-bar-skill-trigger'
export { AGENT_TAG } from './compose-bar/compose-bar-agent-trigger'

export type {
  ComposeBarAction,
  ComposeBarAttachment,
  ComposeBarAttachments,
  ComposeBarAttachmentStatus,
  ComposeBarClassNames,
  ComposeBarFileInput,
  ComposeBarHandle,
  ComposeBarInput,
  ComposeBarAiToggle,
  ComposeBarOption,
  ComposeBarPicker,
  ComposeBarProps,
  ComposeBarQualityControl,
  ComposeBarSubmit,
  ComposeBarSubmitPayload,
  ComposeBarSession,
  ComposeBarSessionAction,
  ComposeBarSessionPhase,
  ComposeBarSessionQuestion,
  ComposeBarSessionQuestionLabels,
  ComposeBarSessionQuestionOption,
  ComposeBarSessionQuestions,
  ComposeBarSessionQuestionSelection,
  ComposeBarSessionTodo,
  ComposeBarSessionTodos,
  ComposeBarSkill,
  ComposeBarPickerLabels,
  ComposeBarSkills,
  ComposeBarAgent,
  ComposeBarAgents,
} from './compose-bar/types'
