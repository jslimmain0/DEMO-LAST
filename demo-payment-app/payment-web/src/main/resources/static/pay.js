const form = document.getElementById('payment-form');
const button = form.querySelector('button');
const status = document.getElementById('status');
const error = document.getElementById('error');
const cards = document.getElementById('cards');
const returnForm = document.getElementById('return-form');

form.addEventListener('submit', async event => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(form));
  [body.cardIssuer, body.cardNumber] = body.card.split(':');
  delete body.card;
  button.disabled = true;
  cards.disabled = true;
  form.setAttribute('aria-busy', 'true');
  error.textContent = '';
  status.textContent = '선택한 카드로 결제 인증을 요청하고 있습니다.';
  try {
    const response = await fetch('/api/payments/complete', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(65000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '결제 인증에 실패했습니다.');
    if (new URL(result.returnUrl).href !== returnForm.action || result.callbackFields?.code !== 'READY')
      throw new Error('인증 결과의 콜백 주소 또는 데이터가 올바르지 않습니다.');
    const fields = ['paymentId', 'merchantId', 'orderId', 'amount', 'code', 'cardIssuer', 'cardLast4'];
    returnForm.replaceChildren(...fields.map(name => {
      const value = result.callbackFields[name];
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error('인증 결과 필드가 올바르지 않습니다.');
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = name; input.value = String(value);
      return input;
    }));
    status.textContent = '결제 인증 완료. 가맹점으로 인증 결과를 전달합니다.';
    button.textContent = '가맹점으로 이동 중';
    HTMLFormElement.prototype.submit.call(returnForm);
  } catch (failure) {
    status.textContent = '결제 인증이 완료되지 않았습니다.';
    error.textContent = failure.message;
    cards.disabled = false;
    button.disabled = false;
    button.textContent = '결제 인증 다시 시도';
  } finally { form.removeAttribute('aria-busy'); }
});
