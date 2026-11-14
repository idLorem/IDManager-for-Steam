// Asks for Steam Guard codes one at a time, so a typed code always belongs to the prompt
// on screen. Both accounts log in in parallel and may both need a code.
// ask(n, domain, wrong) shows the prompt; onCode(handler) listens for the answer and returns an unsubscribe function.
// asker.cancel() drops the open prompt and all queued ones, used when the operation has already ended.
function makeAsker({ ask, onCode, timeout = 120000 }) {
  let chain = Promise.resolve(), epoch = 0, abort = null;
  const asker = (n, domain, wrong) => {
    const mine = epoch;
    const p = chain.then(() => new Promise((resolve, reject) => {
      if (mine !== epoch) return reject(new Error('Steam Guard prompt cancelled'));
      let timer;
      const done = () => { clearTimeout(timer); off(); abort = null; };
      const off = onCode((code) => { done(); resolve(code); });
      timer = setTimeout(() => {
        done();
        reject(Object.assign(new Error('Steam Guard code timeout'), { key: 'codeTimeout', p: { n } }));
      }, timeout);
      abort = (e = new Error('Steam Guard prompt cancelled')) => { done(); reject(e); };
      ask(n, domain, wrong);
    }));
    chain = p.catch(() => {}); // a timeout must not block the next prompt
    return p;
  };
  asker.cancel = () => { epoch++; if (abort) abort(); };
  // the user gives up on the open prompt: only this login fails (it is skipped), queued prompts of other logins stay
  asker.skip = () => { if (abort) abort(Object.assign(new Error('Steam Guard login cancelled'), { key: 'loginCancelled' })); };
  return asker;
}

module.exports = { makeAsker };
