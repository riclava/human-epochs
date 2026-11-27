import { z } from "zod";

export interface User {
  id: string;
  displayName: string;
  email: string;
  canManageAgentSettings: boolean;
}

const cleanName = z.string().trim().min(1).max(40).refine(name => !/[\u0000-\u001f\uD800-\uDFFF]/u.test(name));
export const passwordMinLength = 10;
const newPassword = z.string().min(passwordMinLength).max(1024);
const currentPassword = z.string().min(1).max(1024);

export const registrationSchema = z.strictObject({
  email: z.string().trim().max(254).pipe(z.email()).transform(email => email.toLowerCase()),
  displayName: cleanName,
  password: newPassword,
});
export type Registration = z.infer<typeof registrationSchema>;

export const accountCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("rename"), displayName: cleanName }),
  z.strictObject({ operation: z.literal("change_password"), currentPassword, newPassword }),
  z.strictObject({ operation: z.literal("delete"), password: currentPassword }),
]);
export type AccountCommand = z.infer<typeof accountCommandSchema>;
