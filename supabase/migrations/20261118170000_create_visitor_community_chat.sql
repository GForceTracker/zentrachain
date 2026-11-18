create table public.community_members (
 user_id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null default 'Member',
 status text not null default 'active' check(status in ('active','muted','removed')),
 restriction_note text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.community_messages (
 id uuid primary key default gen_random_uuid(),
 sender_id uuid not null references auth.users(id) on delete cascade,
 author_name text not null, body text, image_path text,
 reply_to uuid references public.community_messages(id) on delete set null,
 deleted_at timestamptz, deleted_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 constraint community_message_body_length check(body is null or char_length(body)<=3000),
 constraint community_message_has_content check((body is not null and char_length(btrim(body))>0) or image_path is not null),
 constraint community_message_image_owner check(image_path is null or split_part(image_path,'/',1)=sender_id::text)
);
create index community_messages_created_at_idx on public.community_messages(created_at desc);
create index community_messages_reply_to_idx on public.community_messages(reply_to);
create or replace function public.community_set_member_display_name() returns trigger language plpgsql set search_path='' as $$
begin
 select coalesce(nullif(btrim(p.full_name),''),nullif(split_part(p.email,'@',1),''),'Member') into new.display_name from public.profiles p where p.id=new.user_id;
 if new.display_name is null then raise exception 'A ZentraChain account profile is required to join the community'; end if;
 new.updated_at:=now(); return new;
end; $$;
create trigger community_member_profile_name before insert or update of user_id on public.community_members for each row execute function public.community_set_member_display_name();
create or replace function public.community_set_message_author() returns trigger language plpgsql set search_path='' as $$
begin
 select coalesce(nullif(btrim(p.full_name),''),nullif(split_part(p.email,'@',1),''),'Member') into new.author_name from public.profiles p where p.id=new.sender_id;
 if new.author_name is null then raise exception 'A ZentraChain account profile is required to post'; end if;
 return new;
end; $$;
create trigger community_message_profile_name before insert on public.community_messages for each row execute function public.community_set_message_author();
alter table public.community_members enable row level security;
alter table public.community_messages enable row level security;
create policy "Community members read own membership and admins read all" on public.community_members for select to authenticated using(user_id=(select auth.uid()) or (select private.is_admin()));
create policy "Users can join community once" on public.community_members for insert to authenticated with check(user_id=(select auth.uid()) and status='active' and restriction_note is null);
create policy "Admins manage community membership" on public.community_members for update to authenticated using((select private.is_admin())) with check((select private.is_admin()));
create policy "Active and muted members read community messages" on public.community_messages for select to authenticated using((select private.is_admin()) or exists(select 1 from public.community_members m where m.user_id=(select auth.uid()) and m.status in ('active','muted')));
create policy "Active members send community messages" on public.community_messages for insert to authenticated with check(sender_id=(select auth.uid()) and deleted_at is null and deleted_by is null and exists(select 1 from public.community_members m where m.user_id=(select auth.uid()) and m.status='active'));
create policy "Admins moderate community messages" on public.community_messages for update to authenticated using((select private.is_admin())) with check((select private.is_admin()));
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('community-photos','community-photos',false,5242880,array['image/jpeg','image/png','image/webp','image/gif']) on conflict(id) do update set public=false,file_size_limit=5242880,allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif'];
create policy "Community members view community photos" on storage.objects for select to authenticated using(bucket_id='community-photos' and ((select private.is_admin()) or exists(select 1 from public.community_members m where m.user_id=(select auth.uid()) and m.status in ('active','muted'))));
create policy "Active community members upload their own photos" on storage.objects for insert to authenticated with check(bucket_id='community-photos' and (storage.foldername(name))[1]=(select auth.uid())::text and exists(select 1 from public.community_members m where m.user_id=(select auth.uid()) and m.status='active'));
create policy "Owners and admins delete community photos" on storage.objects for delete to authenticated using(bucket_id='community-photos' and ((storage.foldername(name))[1]=(select auth.uid())::text or (select private.is_admin())));
do $$ begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='community_messages') then alter publication supabase_realtime add table public.community_messages; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='community_members') then alter publication supabase_realtime add table public.community_members; end if;
end $$;
grant select,insert,update on public.community_members to authenticated;
grant select,insert,update on public.community_messages to authenticated;
