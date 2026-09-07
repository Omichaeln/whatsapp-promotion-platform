/**
 * Durable worker (spec 10.1): drains the outbound-message ledger to the
 * WhatsApp transport and the CRM outbox to the configured provider, with
 * idempotency keys, bounded exponential backoff, and dead letters.
 */
export function createWorker({ transport, outbox, crm, intervalMs = 2000, log = console }) {
  let timer = null;
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      // 1 - outbound WhatsApp messages (ledger, idempotency key)
      for (let i = 0; i < 20; i++) {
        const res = await outbox.processPendingWhatsApp(async (provider, payload) => {
          const msgId = await transport.send({ waPhoneUid: payload.waPhoneUid, kind: payload.kind, payload: payload.body, idempotencyKey: payload.idempotencyKey });
          return msgId;
        });
        if (!res) break;
      }
      // 2 - CRM outbox
      for (let i = 0; i < 10; i++) {
        const res = await crm.deliverOne();
        if (!res) break;
      }
    } catch (e) {
      log.error?.("[worker]", e.message);
    } finally {
      running = false;
    }
  }
  return {
    start() { if (!timer) timer = setInterval(tick, intervalMs); },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    tick,
  };
}