export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export type MailSender = (message: MailMessage) => Promise<void>;

// Links in mail point at the web page, which then calls the API with the token from its address.
export interface MailSettings {
  send: MailSender;
  baseUrl: string;
}

export type MailConfig =
  | { provider: "none" }
  | { provider: "log" }
  | { provider: "resend"; apiKey: string; from: string; apiUrl: string };

// "log" writes the message to standard error for local development, links included; it is refused in production.
// "resend" posts to a Resend-compatible HTTP API. Other providers add another branch here.
export function createMailSender(config: MailConfig, fetchImpl: typeof fetch = fetch): MailSender | null {
  switch (config.provider) {
    case "none": return null;
    case "log": return async message => { console.error(JSON.stringify({ event: "mail", ...message })); };
    case "resend": return async message => {
      const response = await fetchImpl(config.apiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: config.from, to: [message.to], subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Mail provider answered ${response.status}`);
    };
  }
}
