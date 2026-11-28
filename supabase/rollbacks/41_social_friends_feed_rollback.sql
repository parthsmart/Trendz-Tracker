-- Rollback for 41_social_friends_feed.sql.
-- Take a backup of the social tables first if any rows should be kept: this
-- removes the social feature completely (friends, feed, reactions, reports).

DROP TRIGGER IF EXISTS trg_feed_level_up ON public.profiles;
DROP TRIGGER IF EXISTS trg_feed_badge ON public.student_badges;
DROP TRIGGER IF EXISTS trg_feed_personal_best ON public.student_xp_events;

DROP FUNCTION IF EXISTS public.social_update_settings(uuid, boolean, boolean, boolean);
DROP FUNCTION IF EXISTS public.social_handle_report(bigint, text, text);
DROP FUNCTION IF EXISTS public.social_end_friendship(uuid, uuid);
DROP FUNCTION IF EXISTS public.social_remove_item(bigint, boolean);
DROP FUNCTION IF EXISTS public.social_decide_request(uuid, boolean);
DROP FUNCTION IF EXISTS public.social_mod_queue(uuid);
DROP FUNCTION IF EXISTS public.social_staff_name(uuid);
DROP FUNCTION IF EXISTS public.social_set_auto_post(boolean);
DROP FUNCTION IF EXISTS public.social_hide_item(bigint, boolean);
DROP FUNCTION IF EXISTS public.social_reactions_for(text, text[]);
DROP FUNCTION IF EXISTS public.social_react(text, text, text);
DROP FUNCTION IF EXISTS public.social_can_react(uuid, text, text);
DROP FUNCTION IF EXISTS public.social_feed(text, bigint, integer);
DROP FUNCTION IF EXISTS public.social_reaction_counts(text, text, uuid);
DROP FUNCTION IF EXISTS public.social_report(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.social_unblock(uuid);
DROP FUNCTION IF EXISTS public.social_block(uuid);
DROP FUNCTION IF EXISTS public.social_unfriend(uuid);
DROP FUNCTION IF EXISTS public.social_cancel_request(uuid);
DROP FUNCTION IF EXISTS public.social_respond_request(uuid, boolean);
DROP FUNCTION IF EXISTS public.social_request_friend(uuid);
DROP FUNCTION IF EXISTS public.social_home();
DROP FUNCTION IF EXISTS public.trg_feed_personal_best();
DROP FUNCTION IF EXISTS public.trg_feed_badge();
DROP FUNCTION IF EXISTS public.trg_feed_level_up();
DROP FUNCTION IF EXISTS public.feed_post_batch_event(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.feed_post(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.social_level_rank(text);
DROP FUNCTION IF EXISTS public.social_rate_take(uuid, text, integer, interval);
DROP FUNCTION IF EXISTS public.social_can_moderate(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.social_enabled(uuid, text);
DROP FUNCTION IF EXISTS public.social_are_friends(uuid, uuid);
DROP FUNCTION IF EXISTS public.social_blocked(uuid, uuid);
DROP FUNCTION IF EXISTS public.social_student(uuid);

DROP TABLE IF EXISTS public.social_rate_events;
DROP TABLE IF EXISTS public.safety_reports;
DROP TABLE IF EXISTS public.social_reactions;
DROP TABLE IF EXISTS public.feed_items;
DROP TABLE IF EXISTS public.student_blocks;
DROP TABLE IF EXISTS public.friendships;
DROP TABLE IF EXISTS public.friend_requests;
DROP TABLE IF EXISTS public.social_prefs;
DROP TABLE IF EXISTS public.social_settings;
