export type ReplyMailScope = { conversationId: string; messageId: string; replyRevision: number; bodyHash: string; actionRevision: number; contactId: string; recipientHash: string };
export const replyMailValues = (scope: ReplyMailScope) => ["client_reply", scope.conversationId, scope.messageId, scope.replyRevision, scope.bodyHash, scope.actionRevision, scope.contactId, scope.recipientHash];
