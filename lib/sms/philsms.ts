export interface SendSMSParams {
  recipient: string;
  phone: string;
  message: string;
  invoiceId?: string;
}

export interface SendSMSResult {
  success: boolean;
  /** true when the gateway is not configured and the message was NOT actually sent */
  simulated?: boolean;
  /** The provider may have accepted the request; do not blindly retry. */
  uncertain?: boolean;
  messageId?: string;
  providerStatus?: string;
  error?: string;
}

function providerMessage(data: any): string | null {
  const message = data?.message ?? data?.error ?? data?.errors;
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') return JSON.stringify(message);
  return null;
}

export async function sendPhilSMS({ phone, message }: SendSMSParams): Promise<SendSMSResult> {
  const apiKey = process.env.PHILSMS_API_KEY;

  if (!apiKey) {
    console.warn('PHILSMS_API_KEY is not configured — SMS recorded in simulation mode only.');
    return { success: false, simulated: true, error: 'PhilSMS is not configured; no SMS was sent.' };
  }

  try {
    const response = await fetch('https://dashboard.philsms.com/api/v3/sms/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        recipient: phone.replace(/[^0-9]/g, ''),
        sender_id: process.env.PHILSMS_SENDER_ID || 'PhilSMS',
        type: 'plain',
        message,
      }),
    });

    const data = await response.json().catch(() => null);
    const providerStatus = typeof data?.status === 'string' ? data.status : undefined;
    const detail = providerMessage(data);

    if (!response.ok) {
      return {
        success: false,
        providerStatus,
        uncertain: response.status >= 500 || response.status === 408,
        error: `PhilSMS returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`,
      };
    }

    // Do not infer acceptance from HTTP 2xx alone. PhilSMS can return an API
    // error in a successful HTTP response; require its explicit success status.
    if (providerStatus?.toLowerCase() !== 'success') {
      return {
        success: false,
        providerStatus,
        // An unsuccessful/unknown body is not proof the provider did not accept it.
        uncertain: true,
        error: detail || 'PhilSMS did not confirm acceptance (missing or unsuccessful provider status).',
      };
    }

    return {
      success: true,
      providerStatus,
      messageId: data?.data?.uid || data?.data?.message_id || data?.message_id || undefined,
    };
  } catch (e: any) {
    console.error('PhilSMS gateway request failed:', e);
    return { success: false, uncertain: true, error: e?.message || 'PhilSMS gateway network error.' };
  }
}
