import "jsr:@supabase/functions-js/edge-runtime.d.ts";
const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const reply=(body:Record<string,unknown>,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
Deno.serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return reply({error:"Method not allowed"},405);
 const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 const email=(Deno.env.get("Admin_Email")||Deno.env.get("ADMIN_EMAIL")||"").trim().toLowerCase();
 const password=Deno.env.get("Admin_Password")||Deno.env.get("ADMIN_PASSWORD")||"";
 if(!url||!key)return reply({error:"Server authentication is not configured."},503);
 if(!email||!password)return reply({configured:false});
 if(password.length<12||!email.includes("@"))return reply({error:"Administrator credentials are not configured correctly."},503);
 const headers={apikey:key,Authorization:`Bearer ${key}`,"Content-Type":"application/json"};
 try{
  let user:any=null;
  const create=await fetch(`${url}/auth/v1/admin/users`,{method:"POST",headers,body:JSON.stringify({email,password,email_confirm:true,user_metadata:{full_name:"Administrator"}})});
  if(create.ok)user=await create.json();
  else{
   const list=await fetch(`${url}/auth/v1/admin/users?page=1&per_page=1000`,{headers});
   if(!list.ok){console.error("Admin user lookup failed:",list.status);return reply({error:"Could not verify the configured administrator account."},500);}
   const payload=await list.json();user=(payload.users||[]).find((u:any)=>String(u.email||"").toLowerCase()===email)||null;
   if(!user){console.error("Admin user creation failed:",create.status);return reply({error:"Could not create the configured administrator account."},500);}
   const update=await fetch(`${url}/auth/v1/admin/users/${user.id}`,{method:"PUT",headers,body:JSON.stringify({password,email_confirm:true})});
   if(!update.ok){console.error("Admin credential sync failed:",update.status);return reply({error:"Could not synchronize the configured administrator credentials."},500);}
   user=await update.json();
  }
  const patch=await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`,{method:"PATCH",headers:{...headers,Prefer:"return=representation"},body:JSON.stringify({role:"admin"})});
  if(!patch.ok){console.error("Admin profile promotion failed:",patch.status);return reply({error:"The administrator access profile could not be prepared."},500);}
  const rows=await patch.json();
  if(!Array.isArray(rows)||rows.length===0){
   const insert=await fetch(`${url}/rest/v1/profiles?on_conflict=id`,{method:"POST",headers:{...headers,Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify({id:user.id,email,full_name:"Administrator",role:"admin"})});
   if(!insert.ok){console.error("Admin profile creation failed:",insert.status);return reply({error:"The administrator profile could not be created."},500);}
  }
  return reply({configured:true,ready:true});
 }catch(e){console.error("Admin account provisioning failed:",e instanceof Error?e.message:"unknown");return reply({error:"Administrator account setup could not be completed."},500);}
});