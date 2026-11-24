// Each request approves one MR. A lost response is never retried automatically.
export const BATCH_APPROVAL_SCRIPT = `(function(){
  var form=document.getElementById('batch-approval');if(!form)return;
  var bulk=document.getElementById('batch-approve-all'),progress=document.getElementById('batch-progress'),message=document.getElementById('batch-message'),busy=false;
  function cards(){return Array.from(document.querySelectorAll('[data-batch-item]'))}
  function ready(){return cards().filter(function(c){return c.dataset.status==='ready'})}
  function controls(disabled){form.querySelectorAll('button').forEach(function(b){b.disabled=disabled||b.dataset.done==='true'})}
  function update(card,status,text){card.dataset.status=status;var state=card.querySelector('[data-batch-status]');state.dataset.status=status;state.textContent=({approved:'✅ ',already:'✅ ',failed:'❌ ',unknown:'⚠️ ',working:'⏳ '}[status]||'')+text;var button=card.querySelector('[data-approve-item]');if(button&&status!=='working'){button.disabled=true;button.dataset.done='true';button.hidden=true;if(button.parentElement)button.parentElement.hidden=true}if(status==='approved'){var approval=card.querySelector('[data-live="approvals"]');if(approval)approval.textContent='Approved by you'}}
  form.addEventListener('submit',async function(event){
    event.preventDefault();if(busy)return;var button=event.submitter,selected=button&&button.hasAttribute('data-approve-item')?[button.closest('[data-batch-item]')]:ready();selected=selected.filter(function(c){return c&&c.dataset.status==='ready'});if(!selected.length)return;
    busy=true;controls(true);progress.hidden=false;progress.max=selected.length;progress.value=0;message.dataset.state='working';message.textContent='Starting approvals…';
    for(var i=0;i<selected.length;i++){
      var card=selected[i];update(card,'working','Approving…');message.textContent='Approving '+(i+1)+' of '+selected.length+'…';
      try{var body=new URLSearchParams(new FormData(form));body.set('item_index',card.dataset.index);var response=await fetch(form.action,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:body.toString()});if(!response.ok)throw new Error('request failed');var result=await response.json();if(!['approved','already','failed','unknown'].includes(result.status)||typeof result.text!=='string')throw new Error('invalid response');update(card,result.status,result.text)}catch(error){update(card,'unknown','Outcome unknown. Check GitLab before retrying.')}
      progress.value=i+1;
    }
    var failures=selected.filter(function(c){return c.dataset.status==='failed'||c.dataset.status==='unknown'}).length;var all=cards().every(function(c){return c.dataset.status==='approved'||c.dataset.status==='already'});message.dataset.state=failures?'failed':'ok';message.textContent=failures?'❌ '+failures+' of '+selected.length+' approval(s) were not confirmed.':all&&cards().every(function(c){return c.dataset.status==='approved'})?'✅ All MRs were approved successfully.':all?'✅ All MRs are approved.':'✅ '+selected.length+' approval(s) confirmed.';
    busy=false;controls(false);var remaining=ready().length;if(bulk){bulk.hidden=!remaining;bulk.textContent='👍 Approve all ('+remaining+')'}var prompt=document.getElementById('batch-prompt');if(prompt&&!remaining)prompt.hidden=true
  });
})();`;
