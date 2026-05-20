import { z } from "zod";

export const MessageSchema = z.object({
  role: z.enum(["customer", "agent", "system"]),
  content: z.string(),
  timestamp: z.string(),
});

export const ConversationSchema = z.object({
  id: z.string(),
  date: z.string(),
  channel: z.enum(["phone", "email", "chat", "social"]),
  agent: z.string().optional(),
  messages: z.array(MessageSchema),
  resolution: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const CrmRecordSchema = z.object({
  customerId: z.string(),
  name: z.string(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  accountType: z.enum(["personal", "business"]).optional(),
  createdAt: z.string(),
  conversations: z.array(ConversationSchema),
});

export type CrmRecord = z.infer<typeof CrmRecordSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type Message = z.infer<typeof MessageSchema>;
