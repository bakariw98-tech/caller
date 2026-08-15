import { config } from '../config.js';

export interface SmsProvider {
  send(to: string, body: string): Promise<void>;
}

/**
 * Account linking needs SMS, and the Voice Agent API does not send it — voice
 * and messaging are separate problems. The provider is behind this interface so
 * the choice of vendor stays a one-file decision and never leaks into the
 * identity flow.
 */
class ConsoleSmsProvider implements SmsProvider {
  async send(to: string, body: string): Promise<void> {
    console.log(`[sms] to=${to} body=${body}`);
  }
}

class TwilioSmsProvider implements SmsProvider {
  async send(to: string, body: string): Promise<void> {
    const sid = config.sms.accountSid;
    const token = config.sms.apiKey;
    if (!sid || !token || !config.sms.from) {
      throw new Error('SMS_ACCOUNT_SID, SMS_API_KEY and SMS_FROM are required for the twilio provider');
    }

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: config.sms.from, Body: body }),
    });

    if (!res.ok) {
      throw new Error(`SMS send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  }
}

let provider: SmsProvider | null = null;

export function getSmsProvider(): SmsProvider {
  if (provider) return provider;
  provider = config.sms.provider === 'twilio' ? new TwilioSmsProvider() : new ConsoleSmsProvider();
  return provider;
}

/** Test seam. */
export function setSmsProvider(p: SmsProvider): void {
  provider = p;
}
