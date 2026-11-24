var CONTACT_EMAIL="info@exodiadigitals.com";
var REVIEWS=[];/* add {quote,name,role} when you have real client reviews */
document.getElementById('f').addEventListener('submit',function(e){
 e.preventDefault();var d=new FormData(this),ok=document.getElementById('ok');
 var body="Name: "+d.get('n')+"\nEmail: "+d.get('e')+"\nNeeds: "+d.get('t')+"\n\n"+(d.get('m')||"");
 var url="mailto:"+CONTACT_EMAIL+"?subject="+encodeURIComponent("Project inquiry from "+d.get('n'))+"&body="+encodeURIComponent(body);
 ok.innerHTML='Your email app should open with the message ready to send. <a href="'+url+'" target="_top">Click here if it did not.</a>';
 ok.style.display='block';try{window.open(url,'_top')}catch(x){}
});
if(REVIEWS.length){var g=document.getElementById('qgrid');REVIEWS.forEach(function(r){var f=document.createElement('figure'),b=document.createElement('blockquote'),c=document.createElement('figcaption');b.textContent='\u201C'+r.quote+'\u201D';c.textContent=r.name+(r.role?', '+r.role:'');f.append(b,c);g.append(f)});document.getElementById('reviews').hidden=false}
