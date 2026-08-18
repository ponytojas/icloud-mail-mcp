import { z } from 'zod';

const nonEmptyText = (label: string, maximum: number) =>
  z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} cannot be empty`)
    .max(maximum, `${label} is too long`)
    .refine((value) => !/[\0\r\n]/u.test(value), {
      message: `${label} cannot contain control characters`,
    });

export const emailAddressSchema = z
  .string()
  .trim()
  .email('Invalid email address')
  .max(320);

export const mailboxSchema = nonEmptyText('Mailbox name', 255);
export const uidSchema = z
  .string()
  .regex(/^[1-9]\d*$/u, 'Message IDs must be positive numeric IMAP UIDs')
  .refine((value) => Number.isSafeInteger(Number(value)), {
    message: 'Message ID is outside the supported IMAP UID range',
  });

export const uidArraySchema = z
  .array(uidSchema)
  .min(1, 'At least one message ID is required')
  .max(100, 'At most 100 message IDs may be changed at once')
  .transform((ids) => [...new Set(ids)]);

export const flagSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) =>
      /^\\[A-Za-z]+$/u.test(value) ||
      (!/[\0\r\n]/u.test(value) &&
        ![' ', '(', ')', '{', '}', '%', '*', '"', '\\'].some((character) =>
          value.includes(character)
        )),
    {
      message: 'Invalid IMAP flag',
    }
  );

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Date must use YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }, 'Date is not a real calendar date');

export const confirmSchema = z.literal(true, {
  errorMap: () => ({
    message:
      'This action changes your mailbox or sends email. Ask the user for confirmation, then call again with confirm: true.',
  }),
});

export const organizationRuleSchema = z.object({
  name: nonEmptyText('Rule name', 100),
  condition: z
    .object({
      fromContains: nonEmptyText('fromContains', 320).optional(),
      subjectContains: nonEmptyText('subjectContains', 500).optional(),
    })
    .refine(
      (condition) => condition.fromContains || condition.subjectContains,
      'Each rule needs at least one condition'
    ),
  action: z.object({ moveToMailbox: mailboxSchema }),
});

export const configSchema = z.object({
  email: emailAddressSchema,
  appPassword: z.string().trim().min(1).max(256),
  imapHost: z.string().trim().min(1).max(253).default('imap.mail.me.com'),
  imapPort: z.number().int().min(1).max(65535).default(993),
  smtpHost: z.string().trim().min(1).max(253).default('smtp.mail.me.com'),
  smtpPort: z.number().int().min(1).max(65535).default(587),
});

export const commonSchemas = {
  empty: z.object({}).strict(),
  mailboxOptions: z.object({
    mailbox: mailboxSchema.default('INBOX'),
    limit: z.number().int().min(1).max(50).default(10),
    unreadOnly: z.boolean().default(false),
  }),
  sendEmail: z
    .object({
      to: z.union([
        emailAddressSchema,
        z.array(emailAddressSchema).min(1).max(50),
      ]),
      subject: z.string().max(998),
      text: z.string().max(1_000_000).optional(),
      html: z.string().max(1_000_000).optional(),
      confirm: confirmSchema,
    })
    .refine((value) => value.text !== undefined || value.html !== undefined, {
      message: 'Either text or html content is required',
    }),
  messageMutation: z.object({
    messageIds: uidArraySchema,
    mailbox: mailboxSchema.default('INBOX'),
    confirm: confirmSchema,
  }),
  mailboxMutation: z.object({ name: mailboxSchema, confirm: confirmSchema }),
  moveMessages: z.object({
    messageIds: uidArraySchema,
    sourceMailbox: mailboxSchema,
    destinationMailbox: mailboxSchema,
    confirm: confirmSchema,
  }),
  searchMessages: z
    .object({
      query: z.string().trim().min(1).max(500).optional(),
      mailbox: mailboxSchema.default('INBOX'),
      limit: z.number().int().min(1).max(50).default(10),
      dateFrom: isoDateSchema.optional(),
      dateTo: isoDateSchema.optional(),
      fromEmail: emailAddressSchema.optional(),
      unreadOnly: z.boolean().default(false),
    })
    .refine(
      (value) =>
        !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo,
      { message: 'dateFrom must not be after dateTo' }
    ),
  setFlags: z.object({
    messageIds: uidArraySchema,
    flags: z.array(flagSchema).min(1).max(20),
    mailbox: mailboxSchema.default('INBOX'),
    action: z.enum(['add', 'remove']).default('add'),
    confirm: confirmSchema,
  }),
  downloadAttachment: z.object({
    messageId: uidSchema,
    attachmentIndex: z.number().int().min(0).max(999).default(0),
    mailbox: mailboxSchema.default('INBOX'),
  }),
  autoOrganize: z
    .object({
      rules: z.array(organizationRuleSchema).min(1).max(25),
      sourceMailbox: mailboxSchema.default('INBOX'),
      dryRun: z.boolean().default(true),
      confirm: z.boolean().optional(),
    })
    .superRefine((value, context) => {
      if (!value.dryRun && value.confirm !== true) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['confirm'],
          message:
            'This action changes your mailbox. Ask the user for confirmation, then call again with dryRun: false and confirm: true.',
        });
      }
    }),
};
