import nodemailer from "nodemailer";
import { config } from "../config";

/**
 * Send-to-Kindle is fire-and-forget: Amazon returns no delivery receipt, and
 * a rejected document is dropped silently. So the strongest claim this module
 * can honestly make is "the message left the SMTP server" — never "the book
 * is on the device". Callers should word their output accordingly.
 *
 * The most common silent failure is the From address not being on Amazon's
 * Approved Personal Document E-mail List, which is why the address is asserted
 * to match SENDER_EMAIL exactly rather than being derived.
 */

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  filename: string;
  bytes: number;
}

export async function sendToKindle(
  buffer: Buffer,
  filename: string
): Promise<SendResult> {
  const from = config.kindle.sender();
  const to = config.kindle.to();

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // STARTTLS
    auth: { user: from, pass: config.kindle.appPassword() },
    // Serverless cold starts make the default timeouts optimistic.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  const info = await transporter.sendMail({
    from,
    to,
    // Amazon ignores the subject for personal documents, but a readable one
    // helps when you are digging through sent mail to debug a missing book.
    subject: filename.replace(/\.epub$/i, ""),
    text: "",
    attachments: [
      { filename, content: buffer, contentType: "application/epub+zip" },
    ],
  });

  return {
    messageId: info.messageId,
    accepted: (info.accepted || []).map(String),
    rejected: (info.rejected || []).map(String),
    filename,
    bytes: buffer.length,
  };
}
