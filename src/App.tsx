import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { APP_VERSION, checkLatestUpdate } from './lib/updates';
import {
  Activity, BadgeCheck, Bell, Bookmark, Check, ChevronDown, Clapperboard, Compass,
  Crown, Film, Heart, Home, ImagePlus, LogOut, Menu, MessageCircle, Music2, Plus, Trash2,
  Search, Settings, ShieldCheck, Sparkles, UserRound, X, Zap, Eye, Send, RefreshCw,
  Share2, Phone, Video, PhoneOff, Mic, MicOff, Camera, CameraOff, Image, LockKeyhole,
  Volume2, VolumeX, Moon, Sun, Play, Pause, Maximize2,
} from 'lucide-react';
import { callApi, clearSessionToken, getSessionToken, setSessionToken, uploadMedia } from './lib/api';
import { classifyVideo, generateVideoCopy, maxBytesFor, videoDuration } from './lib/media';
import { uploadEncryptedAttachment } from './lib/api';
import {
  createE2EEIdentity, unlockE2EEIdentity, deriveConversationKey, encryptText, decryptText,
  encryptFile, decryptFile, conversationSafetyCode, type E2EEIdentity, type StoredE2EEIdentity,
} from './lib/e2ee';

type User = {
  id: string; username: string; display_name: string; bio: string; avatar_url?: string | null;
  is_verified: boolean; follower_count: number; following_count: number; posts_count: number; is_admin?: boolean; is_following?: boolean;
};
type Post = {
  id: string; title?: string; caption: string; media_url: string; media_type: 'image' | 'video';
  kind: 'photo' | 'reel' | 'video'; duration_seconds: number; likes_count: number;
  comments_count: number; views_count?: number; created_at: string; author: User; liked: boolean; is_world_featured?: boolean;
};
type Story = { id: string; media_url: string; media_type: 'image' | 'video'; caption: string; author: User; created_at: string };
type Tab = 'home' | 'reels' | 'explore' | 'messages' | 'profile' | 'notifications' | 'settings' | 'admin';
type DMMessage = {
  id: string; conversation_id: string; sender_id: string; content: string; created_at: string;
  message_type?: 'text' | 'image' | 'voice' | 'shared_post'; media_url?: string | null;
  attachment_iv?: string | null; attachment_mime?: string | null; e2ee_version?: number;
  shared_post?: { id: string; caption: string; media_url: string; media_type: 'image' | 'video'; kind: string; author: User } | null;
};
type DMConversation = {
  id: string; status: 'pending' | 'accepted' | 'declined'; requester_id: string;
  created_at: string; last_message_at: string; otherUser: User;
  last_message: { content: string; sender_id: string; created_at: string; preview?: string } | null;
};
type UpdatePhase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error';
type UpdateUiState = {
  phase: UpdatePhase;
  message: string;
  latestVersion?: string;
  progress?: number;
  downloadUrl?: string;
  releaseUrl?: string;
};

const ago = (v: string) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago';
};
const initial = (value: string) => value.trim().slice(0, 1).toUpperCase() || 'V';
const worldRankScore = (post: Post) => {
  const ageHours = Math.max(0, (Date.now() - new Date(post.created_at).getTime()) / 3600000);
  return ageHours * 0.25 + post.likes_count * 1.5 + post.comments_count * 2.5 + (post.views_count || 0) * 0.05;
};
const rankWorldFeed = (items: Post[]) => [...items].sort((a, b) =>
  worldRankScore(b) - worldRankScore(a) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
);

function Avatar({ user, size = 'md', ring = false }: { user?: Partial<User> | null; size?: 'sm' | 'md' | 'lg' | 'xl'; ring?: boolean }) {
  return <div className={'avatar avatar-' + size + (ring ? ' avatar-ring' : '')}>
    {user?.avatar_url ? <img src={user.avatar_url} alt={user.display_name || user.username || 'Profile'} /> : <span>{initial(user?.display_name || user?.username || 'VYRA')}</span>}
  </div>;
}

function VerifiedBadge({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return <span className={'verified-badge verified-badge-' + size} role="img" aria-label="Verified creator" title="Verified creator">
    <BadgeCheck size={size === 'md' ? 14 : 11} strokeWidth={2.8} />
  </span>;
}


function formatPlayerTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const seconds = Math.floor(value);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

const VYRAPlayer = memo(function VYRAPlayer({ src, soundEnabled, onToggleSound, className = '', autoPlay = false, loop = false, postId, onPlay, showTimeline = true }: {
  src: string; soundEnabled: boolean; onToggleSound?: () => void; className?: string; autoPlay?: boolean; loop?: boolean;
  postId?: string; onPlay?: () => void; showTimeline?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  useEffect(() => { if (videoRef.current) videoRef.current.muted = !soundEnabled; }, [soundEnabled]);
  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { video.muted = !soundEnabled; void video.play().catch(() => undefined); }
    else video.pause();
  }
  function seek(value: string) {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    const next = Number(value); video.currentTime = next; setCurrentTime(next);
  }
  function fullscreen() {
    const video = videoRef.current;
    if (!video) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else if (video.requestFullscreen) void video.requestFullscreen().catch(() => undefined);
  }
  return <div className={'vyra-player ' + (playing ? 'is-playing ' : '') + (buffering ? 'is-buffering ' : '') + className}>
    <video ref={videoRef} src={src} data-vyra-player="true" data-post-id={postId}
      muted={!soundEnabled} autoPlay={autoPlay} loop={loop} playsInline preload="metadata"
      aria-label="VYRA video player" onClick={togglePlayback}
      onPlay={() => { setPlaying(true); setBuffering(false); onPlay?.(); }}
      onPause={() => { setPlaying(false); setBuffering(false); }}
      onWaiting={() => setBuffering(true)} onCanPlay={() => setBuffering(false)}
      onEnded={() => setPlaying(false)}
      onLoadedMetadata={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
      onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)} />
    <span className="vyra-player-brand">VYRA PLAYER</span>
    {buffering && <span className="vyra-player-buffer" aria-label="Buffering" />}
    <button className="vyra-player-center" type="button" onClick={togglePlayback} aria-label={playing ? 'Pause video' : 'Play video'}>
      {playing ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" />}
    </button>
    {showTimeline && <div className="vyra-player-controls" onClick={event => event.stopPropagation()}>
      <button type="button" onClick={togglePlayback} aria-label={playing ? 'Pause video' : 'Play video'}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
      <input aria-label="Seek video" type="range" min="0" max={Math.max(duration, 0.01)} step="0.1"
        value={Math.min(currentTime, duration || 0)} onChange={event => seek(event.target.value)} />
      <span className="vyra-player-time">{formatPlayerTime(currentTime)} / {formatPlayerTime(duration)}</span>
      {onToggleSound && <button type="button" onClick={onToggleSound} aria-label={soundEnabled ? 'Mute all VYRA videos' : 'Unmute all VYRA videos'}>{soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}</button>}
      <button type="button" onClick={fullscreen} aria-label="Toggle fullscreen"><Maximize2 size={15} /></button>
    </div>}
  </div>;
});

function Welcome({ onAuth }: { onAuth: (user: User, token: string) => void }) {
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const [step, setStep] = useState(1);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [heard, setHeard] = useState('Google');
  const [birth, setBirth] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const switchMode = (next: 'signup' | 'login') => { setMode(next); setStep(1); setError(''); };
  async function submit() {
    setError('');
    if (mode === 'signup' && step === 1) {
      if (password !== confirm) return setError('Your passwords do not match.');
      if (username.trim().length < 3) return setError('Choose a username with at least 3 characters.');
      if (password.length < 10) return setError('Use at least 10 characters for your password.');
      setStep(2); return;
    }
    if (mode === 'signup' && step === 2) { setStep(3); return; }
    if (mode === 'signup' && !birth) return setError('Choose your birth date to continue.');
    setBusy(true);
    try {
      const result = await callApi<{ user: User; token: string }>(mode === 'signup' ? 'signup' : 'login', {
        username: username.trim().toLowerCase(), password, confirmPassword: confirm, heardAbout: heard, birthDate: birth,
      }, null);
      setSessionToken(result.token); onAuth(result.user, result.token);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not sign in.'); }
    finally { setBusy(false); }
  }
  return <main className="auth-shell">
    <section className="auth-art"><div className="auth-orbit orbit-one" /><div className="auth-orbit orbit-two" />
      <div className="auth-art-copy"><div className="brand brand-light"><span className="brand-mark"><img src="./icon.svg" alt="" /></span> VYRA</div>
        <p className="eyebrow">YOUR NEXT CHAPTER STARTS HERE</p><h1>Make it.<br /><em>Share it.</em><br />Be remembered.</h1>
        <p className="auth-subtitle">A space for the things you make, the people who find them, and the moments that stay.</p>
        <div className="auth-mantra"><span>✦</span> Real fame. Real people. Your moment.</div>
      </div><div className="auth-art-bottom"><span>CREATIVITY HAS NO CEILING</span><span>BUILT BY GEMAA ✦</span><span>01 — 04</span></div>
    </section>
    <section className="auth-panel"><div className="auth-panel-inner">
      <div className="mobile-brand brand"><span className="brand-mark"><img src="./icon.svg" alt="" /></span> VYRA</div>
      <div className="auth-head"><div className="step-kicker">{mode === 'signup' ? 'YOUR JOURNEY STARTS HERE' : 'WELCOME BACK'}</div>
        <h2>{mode === 'login' ? 'Good to see you.' : step === 1 ? 'Create your account.' : step === 2 ? 'One quick question.' : 'When is your birthday?'}</h2>
        <p>{mode === 'login' ? 'Pick up where your creativity left off.' : step === 1 ? 'Claim your corner of the internet.' : step === 2 ? 'How did VYRA find its way to you?' : 'We use this to personalize your experience.'}</p>
      </div>
      {mode === 'signup' && <div className="step-progress"><span className="active" /><span className={step >= 2 ? 'active' : ''} /><span className={step >= 3 ? 'active' : ''} /></div>}
      {mode === 'signup' && step === 1 && <div className="form-stack fade-in">
        <label>USERNAME<input value={username} onChange={e => setUsername(e.target.value)} placeholder="yourcreativehandle" autoComplete="username" maxLength={24} /></label>
        <label>PASSWORD<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 10 characters" autoComplete="new-password" /></label>
        <label>CONFIRM PASSWORD<input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Type it one more time" autoComplete="new-password" /></label>
        <p className="microcopy owner-hint">The reserved username <b>Owner</b> creates the founder account and opens the admin panel directly after login.</p>
      </div>}
      {mode === 'signup' && step === 2 && <div className="choice-grid fade-in">{['Google', 'Friends', 'AI', 'Other'].map((item, i) => <button key={item} className={'choice-card ' + (heard === item ? 'selected' : '')} onClick={() => setHeard(item)}><span>{['◉', '◎', '✧', '↗'][i]}</span><b>{item}</b>{heard === item && <Check size={16} />}</button>)}</div>}
      {mode === 'signup' && step === 3 && <div className="form-stack fade-in"><label>DATE OF BIRTH<input type="date" value={birth} onChange={e => setBirth(e.target.value)} max={new Date().toISOString().slice(0, 10)} /></label><div className="privacy-note"><ShieldCheck size={17} /> Your birth date is private and never shown on your public profile.</div></div>}
      {mode === 'login' && <div className="form-stack fade-in"><label>USERNAME<input value={username} onChange={e => setUsername(e.target.value)} placeholder="yourcreativehandle" autoComplete="username" /></label><label>PASSWORD<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Your password" autoComplete="current-password" onKeyDown={e => e.key === 'Enter' && submit()} /></label></div>}
      {error && <div className="form-error">{error}</div>}
      <button className="button button-primary button-wide" onClick={submit} disabled={busy}>{busy ? 'Setting things up…' : mode === 'login' ? 'Enter VYRA' : step === 3 ? 'Start your journey' : 'Continue'} <span>↗</span></button>
      {mode === 'signup' && step > 1 && <button className="text-button" onClick={() => setStep(step - 1)}>← Back</button>}
      <div className="auth-switch">{mode === 'signup' ? 'Already have a space here?' : 'New around here?'} <button onClick={() => switchMode(mode === 'signup' ? 'login' : 'signup')}>{mode === 'signup' ? 'Log in' : 'Create account'}</button></div>
      <p className="auth-legal">By continuing, you agree to keep this community creative, kind and respectful.</p>
    </div></section>
  </main>;
}

function StoryRail({ stories, me, onAdd, onOpen }: { stories: Story[]; me: User; onAdd: () => void; onOpen: (story: Story) => void }) {
  const seen = new Set<string>();
  const unique = stories.filter(story => { if (seen.has(story.author.id)) return false; seen.add(story.author.id); return true; });
  return <div className="story-rail">
    <button className="story-item" onClick={onAdd}><span className="story-ring own"><Avatar user={me} size="lg" /></span><span className="story-name">Your story</span><i className="story-add"><Plus size={13} /></i></button>
    {unique.map(story => <button className="story-item" key={story.id} onClick={() => onOpen(story)}><span className="story-ring"><Avatar user={story.author} size="lg" /></span><span className="story-name">{story.author.username}</span></button>)}
    {unique.length === 0 && <div className="story-hint">Your next 24 hours could start here.</div>}
  </div>;
}

const PostCard = memo(function PostCard({ post, token, onLike, onComment, onProfile, onView, soundEnabled, onToggleSound }: {
  post: Post; token: string; onLike: (post: Post) => void;
  onComment: (post: Post, text: string) => Promise<void>;
  onProfile: (profile: User) => void; onView?: (postId: string) => void;
  soundEnabled: boolean; onToggleSound: () => void;
}) {
  const [showComments, setShowComments] = useState(false);
  const [commentBusy, setCommentBusy] = useState(false);
  const hasCountedView = useRef(false);
  const [comment, setComment] = useState('');
  const [comments, setComments] = useState<any[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  useEffect(() => {
    if (!showComments) return;
    let active = true;
    setCommentsLoading(true);
    callApi<{ comments: any[] }>('post-comments', { postId: post.id }, token)
      .then(r => { if (active) setComments(r.comments); })
      .catch(() => undefined)
      .finally(() => { if (active) setCommentsLoading(false); });
    return () => { active = false; };
  }, [showComments, post.id, token]);
  async function submitComment(event: FormEvent) {
    event.preventDefault();
    const text = comment.trim();
    if (!text || commentBusy) return;
    const optimisticId = 'local-' + Date.now();
    setComment('');
    setCommentBusy(true);
    setComments(items => [...items, {
      id: optimisticId, content: text, created_at: new Date().toISOString(), author: { username: 'you' },
    }]);
    try {
      await onComment(post, text);
      const result = await callApi<{ comments: any[] }>('post-comments', { postId: post.id }, token);
      setComments(result.comments);
    } catch {
      setComments(items => items.filter(item => item.id !== optimisticId));
      setComment(text);
    } finally { setCommentBusy(false); }
  }
  return <article className="post-card">
    <div className="post-head"><button className="post-author" onClick={() => onProfile(post.author)}><Avatar user={post.author} /><span><b>{post.author.username} {post.author.is_verified && <VerifiedBadge />}</b><small>{ago(post.created_at)} {post.is_world_featured && ' · World spotlight'}</small></span></button><button className="icon-button" aria-label="More options"><ChevronDown size={18} /></button></div>
    <div className="post-media">{post.media_type === 'video' ? <VYRAPlayer src={post.media_url} soundEnabled={soundEnabled} onToggleSound={onToggleSound} className="post-video-player" onPlay={() => { if (!hasCountedView.current) { hasCountedView.current = true; onView?.(post.id); } }} /> : <img src={post.media_url} alt={post.caption || 'Creator post'} loading="lazy" />}{post.kind === 'reel' && <span className="media-label"><Clapperboard size={13} /> REEL</span>}{post.kind === 'video' && <span className="media-label"><Film size={13} /> VIDEO</span>}</div>
    <div className="post-actions"><div><button className={'action-button ' + (post.liked ? 'liked' : '')} onClick={() => onLike(post)} aria-label={post.liked ? 'Unlike' : 'Like'} aria-pressed={post.liked}><Heart size={22} fill={post.liked ? 'currentColor' : 'none'} /></button><button className="action-button" onClick={() => setShowComments(!showComments)} aria-label="Comment"><MessageCircle size={21} /></button></div><button className="action-button" aria-label="Save post"><Bookmark size={20} /></button></div>
    <div className="post-meta"><b>{post.likes_count.toLocaleString()} appreciations{post.media_type === 'video' ? ' · ' + (post.views_count || 0).toLocaleString() + ' views' : ''}</b>{post.title && <h3 className="post-title">{post.title}</h3>}<p><strong>{post.author.username}</strong> {post.caption}</p><button className="comment-link" onClick={() => setShowComments(!showComments)}>View all {post.comments_count} comments</button></div>
    {showComments && <><div className="comments-list">{commentsLoading ? <small>Loading comments…</small> : comments.map(item => <p className="comment-enter" key={item.id}><b>@{item.author?.username || 'creator'}</b> {item.content}</p>)}</div><form className="comment-form" onSubmit={submitComment}><input value={comment} onChange={e => setComment(e.target.value)} placeholder="Add something kind…" maxLength={1000} /><button disabled={!comment.trim() || commentBusy}>{commentBusy ? 'Sending…' : 'Post'}</button></form></>}
  </article>;
});

type BulkVideoItem = {
  id: string;
  file: File;
  title: string;
  description: string;
  durationSeconds: number;
  status: 'preparing' | 'ready' | 'uploading' | 'published' | 'failed' | 'invalid';
  error?: string;
};

function UploadModal({ token, onClose, onDone }: { token: string; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'post' | 'story'>('post');
  const [bulkMode, setBulkMode] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [rights, setRights] = useState(false);
  const [tracks, setTracks] = useState<any[]>([]);
  const [audioTrackId, setAudioTrackId] = useState('');
  const [bulkVideos, setBulkVideos] = useState<BulkVideoItem[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  useEffect(() => { callApi<{ tracks: any[] }>('list-audio', {}, token).then(r => setTracks(r.tracks)).catch(() => undefined); }, [token]);

  function patchBulkVideo(id: string, patch: Partial<BulkVideoItem>) {
    setBulkVideos(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  }

  async function addBulkFiles(files: FileList | null) {
    if (!files?.length) return;
    const selected = Array.from(files);
    const items: BulkVideoItem[] = selected.map(selectedFile => ({
      id: crypto.randomUUID(),
      file: selectedFile,
      ...generateVideoCopy(selectedFile),
      durationSeconds: 0,
      status: 'preparing',
    }));
    setBulkVideos(current => [...current, ...items]);
    setMessage('');
    // Read one video's browser metadata at a time. This keeps large selections
    // from spawning hundreds of decoders/object URLs at the same moment.
    for (const item of items) {
      if (item.file.type !== 'video/mp4' && item.file.type !== 'video/webm') {
        patchBulkVideo(item.id, { status: 'invalid', error: 'Use an MP4 or WebM video.' });
        continue;
      }
      if (item.file.size <= 0 || item.file.size > maxBytesFor(item.file.type)) {
        patchBulkVideo(item.id, { status: 'invalid', error: 'This file is empty or larger than 50 MB.' });
        continue;
      }
      try {
        const durationSeconds = await videoDuration(item.file);
        const copy = generateVideoCopy(item.file, durationSeconds);
        patchBulkVideo(item.id, { ...copy, durationSeconds, status: 'ready', error: undefined });
      } catch {
        patchBulkVideo(item.id, { status: 'invalid', error: 'VYRA could not read this video’s duration. Try exporting it as MP4 or WebM.' });
      }
    }
  }

  async function submitBulk() {
    if (!rights) { setMessage('Confirm you own these videos or have permission to publish them.'); return; }
    const queue = bulkVideos.filter(item => item.status === 'ready' || item.status === 'failed');
    if (!queue.length) { setMessage('Choose at least one ready video to publish.'); return; }
    setBulkBusy(true);
    setMessage('');
    setBulkProgress({ done: 0, total: queue.length });
    let published = 0;
    let failed = 0;
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index];
      patchBulkVideo(item.id, { status: 'uploading', error: undefined });
      try {
        await uploadMedia(item.file, 'post', token, {
          title: item.title.trim() || generateVideoCopy(item.file, item.durationSeconds).title,
          caption: item.description.trim().slice(0, 2200),
          durationSeconds: item.durationSeconds,
          category: classifyVideo(item.durationSeconds),
          rightsConfirmation: 'I own or have permission to publish this media.',
        });
        patchBulkVideo(item.id, { status: 'published', error: undefined });
        published++;
      } catch (error) {
        patchBulkVideo(item.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : 'Upload failed. You can retry this video.',
        });
        failed++;
      }
      setBulkProgress({ done: index + 1, total: queue.length });
    }
    setBulkBusy(false);
    setMessage(
      failed
        ? published + ' video(s) published. ' + failed + ' failed; fix the issue or retry those files.'
        : published + ' video(s) published successfully to VYRA.'
    );
    if (published > 0) onDone();
  }

  async function submitSingle() {
    if (!file) return setMessage('Choose a photo or video first.');
    if (!rights) return setMessage('Please confirm you own or have permission to publish this media.');
    setBusy(true); setMessage('');
    try {
      const duration = file.type.startsWith('video/') ? await videoDuration(file) : 0;
      const category = file.type.startsWith('video/') ? classifyVideo(duration) : 'photo';
      const generatedCopy = kind === 'post' && file.type.startsWith('video/')
        ? generateVideoCopy(file, duration)
        : null;
      await uploadMedia(file, kind, token, {
        title: generatedCopy?.title,
        caption: caption.trim() || generatedCopy?.description || caption,
        durationSeconds: duration, category,
        rightsConfirmation: 'I own or have permission to publish this media.',
        audioTrackId: kind === 'post' ? audioTrackId || undefined : undefined,
      });
      const isVideoPost = kind === 'post' && file.type.startsWith('video/');
      setMessage(kind === 'story' ? 'Story uploaded. It will appear after review.' : isVideoPost ? 'Video published instantly to VYRA and today’s World Feed.' : 'Photo submitted for community review.');
      onDone(); window.setTimeout(onClose, 1100);
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Upload failed.'); }
    finally { setBusy(false); }
  }

  const pendingCount = bulkVideos.filter(item => item.status === 'ready' || item.status === 'failed').length;
  const statusText = (status: BulkVideoItem['status']) => ({
    preparing: 'Preparing',
    ready: 'Ready',
    uploading: 'Uploading',
    published: 'Published',
    failed: 'Failed · retry available',
    invalid: 'Needs attention',
  }[status]);

  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && !bulkBusy && !busy && onClose()}>
    <div className="modal-card upload-modal-card">
      <div className="modal-top"><div><p className="eyebrow">MAKE SOMETHING MATTER</p><h2>Create a moment</h2></div><button className="icon-button" onClick={onClose} disabled={bulkBusy || busy}><X /></button></div>
      <div className="segmented upload-mode-tabs">
        <button disabled={bulkBusy || busy} className={kind === 'post' && !bulkMode ? 'active' : ''} onClick={() => { setKind('post'); setBulkMode(false); }}>Single post</button>
        <button disabled={bulkBusy || busy} className={kind === 'post' && bulkMode ? 'active' : ''} onClick={() => { setKind('post'); setBulkMode(true); }}>Bulk videos</button>
        <button disabled={bulkBusy || busy} className={kind === 'story' ? 'active' : ''} onClick={() => { setKind('story'); setBulkMode(false); }}>24h Story</button>
      </div>

      {bulkMode ? <>
        <div className="bulk-intro"><b>Publish a whole video batch</b><span>Select multiple MP4 or WebM files in one go. VYRA prepares a title and description for every clip.</span></div>
        <label className="file-drop bulk-file-drop"><ImagePlus size={27} /><b>Select multiple videos</b><span>Choose many files together · up to 50 MB per video</span><input type="file" accept="video/mp4,video/webm" multiple disabled={bulkBusy} onChange={event => { void addBulkFiles(event.target.files); event.currentTarget.value = ''; }} /></label>
        {bulkVideos.length > 0 && <div className="bulk-queue">
          <div className="bulk-queue-heading"><b>Upload queue · {bulkVideos.length} video(s)</b><button type="button" className="text-button" onClick={() => setBulkVideos([])} disabled={bulkBusy}>Clear queue</button></div>
          {bulkVideos.map(item => <article className={'bulk-video-item bulk-' + item.status} key={item.id}>
            <div className="bulk-video-heading">
              <div><b title={item.file.name}>{item.file.name}</b><small>{(item.file.size / (1024 * 1024)).toFixed(1)} MB{item.durationSeconds ? ' · ' + Math.round(item.durationSeconds) + ' sec' : ''}</small></div>
              <span className={'bulk-status bulk-status-' + item.status}>{statusText(item.status)}</span>
              <button type="button" className="icon-button" aria-label={'Remove ' + item.file.name} disabled={bulkBusy} onClick={() => setBulkVideos(current => current.filter(video => video.id !== item.id))}><X size={15} /></button>
            </div>
            {item.status !== 'invalid' && <div className="bulk-copy-fields">
              <label>VYRA TITLE<input maxLength={160} value={item.title} disabled={bulkBusy || item.status === 'published'} onChange={event => patchBulkVideo(item.id, { title: event.target.value })} /></label>
              <label>VYRA DESCRIPTION<textarea rows={2} maxLength={2200} value={item.description} disabled={bulkBusy || item.status === 'published'} onChange={event => patchBulkVideo(item.id, { description: event.target.value })} /></label>
            </div>}
            {item.error && <p className="bulk-video-error">{item.error}</p>}
          </article>)}
        </div>}
        {bulkBusy && <div className="bulk-progress"><div><b>Publishing videos</b><span>{bulkProgress.done} / {bulkProgress.total}</span></div><i><span style={{ width: bulkProgress.total ? (bulkProgress.done / bulkProgress.total * 100) + '%' : '0%' }} /></i></div>}
        <p className="microcopy bulk-generator-note">VYRA creates starter copy from each filename and video duration. It does not watch or understand the clip; edit the generated title and description to describe what happens in your video. No external AI service is used.</p>
        <label className="check-line"><input type="checkbox" checked={rights} disabled={bulkBusy} onChange={e => setRights(e.target.checked)} /> I own these videos or have permission to publish all selected content, including audio.</label>
        {message && <div className={message.includes('failed;') ? 'form-error' : message.includes('published successfully') || message.includes('video(s) published') ? 'notice-success' : 'form-error'}>{message}</div>}
        <button className="button button-primary button-wide" onClick={submitBulk} disabled={bulkBusy || busy || !rights || !pendingCount}>
          {bulkBusy ? 'Publishing ' + bulkProgress.done + ' / ' + bulkProgress.total + '…' : 'Publish ' + pendingCount + ' queued video(s)'}
          <span>↗</span>
        </button>
      </> : <>
        <label className="file-drop"><ImagePlus size={28} /><b>{file ? file.name : 'Choose your media'}</b><span>Photo or video · up to 50 MB per file · MP4 supported</span><input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" onChange={e => setFile(e.target.files?.[0] || null)} /></label>
        <label className="modal-label">CAPTION<textarea rows={3} value={caption} onChange={e => setCaption(e.target.value)} placeholder="Give this moment a little context…" maxLength={kind === 'story' ? 500 : 2200} /></label>
        {kind === 'post' && tracks.length > 0 && <label className="modal-label audio-choice">ADD YOUR AUDIO TRACK<select value={audioTrackId} onChange={e => setAudioTrackId(e.target.value)}><option value="">No soundtrack</option>{tracks.map(track => <option key={track.id} value={track.id}>{track.title}{track.artist ? ' — ' + track.artist : ''}</option>)}</select></label>}
        {kind === 'post' && tracks.length === 0 && <p className="microcopy">Add your own licensed MP3/M4A in Settings to attach a soundtrack.</p>}
        {file?.type.startsWith('video/') && <p className="microcopy">Videos up to 2:00 are Reels. Longer videos are categorized as Videos.</p>}
        <label className="check-line"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} /> I own this content or have permission to publish it, including any audio.</label>
        {message && <div className={message.includes('submitted') || message.includes('uploaded') || message.includes('published') ? 'notice-success' : 'form-error'}>{message}</div>}
        <button className="button button-primary button-wide" onClick={submitSingle} disabled={busy}>{busy ? 'Uploading securely…' : kind === 'story' ? 'Share story' : file?.type.startsWith('video/') ? 'Publish video now' : 'Submit photo for review'} <span>↗</span></button>
      </>}
    </div>
  </div>;
}


function ShortCommentsSheet({ post, token, onClose, onComment }: {
  post: Post; token: string; onClose: () => void; onComment: (post: Post, text: string) => Promise<void>;
}) {
  const [items, setItems] = useState<any[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [commentCount, setCommentCount] = useState(post.comments_count);
  const load = useCallback(async () => {
    const result = await callApi<{ comments: any[] }>('post-comments', { postId: post.id }, token);
    setItems(result.comments);
  }, [post.id, token]);
  useEffect(() => {
    let active = true;
    callApi<{ comments: any[] }>('post-comments', { postId: post.id }, token)
      .then(result => { if (active) setItems(result.comments); })
      .catch(() => undefined)
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [post.id, token]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    const text = draft.trim();
    if (!text || busy) return;
    const optimisticId = 'local-' + Date.now();
    setBusy(true); setDraft('');
    setCommentCount(count => count + 1);
    setItems(current => [...current, {
      id: optimisticId, content: text, created_at: new Date().toISOString(), author: { username: 'you' },
    }]);
    try { await onComment(post, text); await load(); }
    catch {
      setItems(current => current.filter(item => item.id !== optimisticId));
      setDraft(text); setCommentCount(count => Math.max(0, count - 1));
    } finally { setBusy(false); }
  }
  return <div className="modal-backdrop shorts-comments-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="shorts-comments-sheet" role="dialog" aria-label="Reel comments">
      <div className="sheet-grab" />
      <header><div><b>Comments</b><small>{commentCount.toLocaleString()} comments</small></div><button className="icon-button" onClick={onClose}><X /></button></header>
      <div className="shorts-comment-list">
        {loading ? <p className="dm-empty-note">Loading comments…</p> : items.length ? items.map(item =>
          <article className="shorts-comment" key={item.id}><Avatar user={item.author} size="sm" /><div><b>@{item.author?.username || 'creator'}</b><p>{item.content}</p><small>{ago(item.created_at)}</small></div></article>
        ) : <div className="dm-no-selection"><MessageCircle size={26} /><b>Start the conversation.</b><p>Be the first to comment on this Reel.</p></div>}
      </div>
      <form className="shorts-comment-compose" onSubmit={submit}>
        <Avatar user={post.author} size="sm" />
        <input autoFocus value={draft} onChange={event => setDraft(event.target.value)} maxLength={1000} placeholder="Add a comment…" />
        <button disabled={busy || !draft.trim()}>{busy ? 'Sending…' : 'Post'}</button>
      </form>
    </section>
  </div>;
}

function ShareSheet({ post, token, identity, onClose, onToast }: {
  post: Post; token: string; identity: E2EEIdentity | null; onClose: () => void; onToast: (message: string) => void;
}) {
  const [conversations, setConversations] = useState<DMConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    callApi<{ conversations: DMConversation[] }>('dm-inbox', {}, token)
      .then(result => { if (active) setConversations(result.conversations.filter(item => item.status === 'accepted')); })
      .catch(error => onToast(error instanceof Error ? error.message : 'Could not load friends.'))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, onToast]);
  async function send(item: DMConversation) {
    if (!identity) { onToast('Open Messages and unlock encrypted chat first.'); return; }
    setSending(item.id);
    try {
      const peer = await callApi<{ key: { publicKey: JsonWebKey } | null }>('e2ee-key-get', { username: item.otherUser.username }, token);
      if (!peer.key?.publicKey) throw new Error('@' + item.otherUser.username + ' has not enabled secure messages yet.');
      const key = await deriveConversationKey(identity, peer.key.publicKey, item.id);
      const content = await encryptText('Shared a Reel with you', key);
      await callApi('dm-share-post', { conversationId: item.id, postId: post.id, content }, token);
      onToast('Reel shared with @' + item.otherUser.username + '.');
      onClose();
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not share this Reel.');
    } finally { setSending(null); }
  }
  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section className="share-sheet" role="dialog" aria-label="Share Reel with friends">
      <header><div><p className="eyebrow">SEND PRIVATELY</p><h3>Share with friends</h3></div><button className="icon-button" onClick={onClose}><X /></button></header>
      <div className="share-preview"><div className="share-preview-thumb">{post.media_type === 'video' ? <video src={post.media_url} muted data-vyra-mute-lock="true" /> : <img src={post.media_url} alt="" />}</div><div><b>@{post.author.username}</b><p>{post.caption || 'A Reel on VYRA'}</p></div></div>
      {!identity && <div className="secure-warning"><LockKeyhole size={16} /> Unlock secure messaging in Messages before sharing.</div>}
      <div className="share-friends">
        {loading ? <p className="dm-empty-note">Loading your chats…</p> : conversations.length ? conversations.map(item =>
          <button key={item.id} className="share-friend" onClick={() => send(item)} disabled={!identity || sending !== null}>
            <Avatar user={item.otherUser} size="md" />
            <span><b>@{item.otherUser.username} {item.otherUser.is_verified && <VerifiedBadge />}</b><small>Encrypted chat</small></span>
            <span className="share-send">{sending === item.id ? 'Sending…' : <Send size={17} />}</span>
          </button>
        ) : <div className="dm-no-selection"><MessageCircle size={26} /><b>No chats to share with yet.</b><p>Accept a message request or start a chat first.</p></div>}
      </div>
      <p className="share-sheet-note"><LockKeyhole size={13} /> The share note is encrypted before it leaves this device.</p>
    </section>
  </div>;
}

function CallOverlay({ call, user, token, onClose, onToast }: {
  call: any; user: User; token: string; onClose: () => void; onToast: (message: string) => void;
}) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const startedRef = useRef(false);
  const processedRef = useRef(0);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const pollingRef = useRef(false);
  const [callStatus, setCallStatus] = useState<'ringing' | 'active' | 'ended'>(call.status);
  const [phase, setPhase] = useState(call.status === 'active' ? 'Connecting…' : 'Calling…');
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(call.call_type === 'video');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const isCaller = call.caller_id === user.id;

  const sendSignal = useCallback(async (signalType: 'offer' | 'answer' | 'ice', payload: any) => {
    await callApi('dm-call-signal', { callId: call.id, signalType, payload }, token);
  }, [call.id, token]);

  const cleanup = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    localStreamRef.current = null;
  }, []);

  async function answerCall() {
    try {
      const result = await callApi<{ call: any }>('dm-call-accept', { callId: call.id }, token);
      setPhase('Connecting…');
      startedRef.current = false;
      // The call status change triggers the peer connection setup effect.
      if (result.call) { setCallStatus('active'); setPhase('Connecting…'); }
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not answer call.'); }
  }

  async function endCall(decision: 'end' | 'decline' = 'end') {
    try { await callApi('dm-call-end', { callId: call.id, decision }, token); }
    catch { /* The local media still must be stopped. */ }
    cleanup();
    onClose();
  }

  const shouldConnect = isCaller || callStatus === 'active';
  useEffect(() => {
    if (!shouldConnect) return;
    if (startedRef.current) return;
    startedRef.current = true;
    let disposed = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
          throw new Error('Calls need an HTTPS connection and browser microphone/camera support.');
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true, video: call.call_type === 'video',
        });
        if (disposed) { stream.getTracks().forEach(track => track.stop()); return; }
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        let iceServers: RTCIceServer[] = [
          { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
        ];
        try {
          const iceConfig = await callApi<{ iceServers?: RTCIceServer[] }>('dm-call-ice-config', {}, token);
          if (iceConfig.iceServers?.length) iceServers = iceConfig.iceServers;
        } catch { /* Public STUN remains available when TURN is not configured. */ }
        const pc = new RTCPeerConnection({ iceServers });
        peerRef.current = pc;
        stream.getTracks().forEach(track => pc.addTrack(track, stream));
        pc.ontrack = event => {
          const next = event.streams[0] || new MediaStream([event.track]);
          setRemoteStream(next);
          if (call.call_type === 'audio') {
            if (remoteAudioRef.current) {
              remoteAudioRef.current.srcObject = next;
              void remoteAudioRef.current.play().catch(() => setPhase('Tap Answer again to enable audio playback'));
            }
          } else if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = next;
            void remoteVideoRef.current.play().catch(() => setPhase('Tap the video area to start playback'));
          }
        };
        pc.onicecandidate = event => {
          if (event.candidate) sendSignal('ice', event.candidate.toJSON()).catch(() => undefined);
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') setPhase('Connected');
          else if (pc.connectionState === 'connecting') setPhase('Connecting…');
          else if (pc.connectionState === 'disconnected') setPhase('Reconnecting…');
          else if (pc.connectionState === 'failed') setPhase('Could not connect. A TURN relay may be required on this network.');
        };
        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === 'failed') setPhase('Network blocked. Configure TURN relay credentials in Supabase to improve call reachability.');
          else if (pc.iceConnectionState === 'disconnected') setPhase('Network interrupted · reconnecting…');
        };
        if (isCaller) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          await sendSignal('offer', offer);
          setPhase('Ringing…');
        } else {
          setPhase('Joining call…');
        }
      } catch (error) {
        const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: string }).name) : '';
        const message = name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? 'Allow VYRA to use your microphone' + (call.call_type === 'video' ? ' and camera' : '') + ' in device settings, then try again.'
          : name === 'NotFoundError' ? 'No compatible microphone or camera was found on this device.'
          : name === 'NotReadableError' ? 'Your microphone or camera is being used by another app.'
          : error instanceof Error ? error.message : 'Could not start call media.';
        setPhase(message);
        onToast(message);
      }
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [call.id, shouldConnect, call.call_type, isCaller, sendSignal, cleanup, onToast]);

  useEffect(() => {
    let active = true;
    async function pollSignals() {
      if (!peerRef.current || pollingRef.current) return;
      pollingRef.current = true;
      try {
        const result = await callApi<{ signals: any[]; status: string }>('dm-call-signals', {
          callId: call.id, afterId: processedRef.current,
        }, token);
        if (!active) return;
        if (result.status === 'ended' || result.status === 'declined' || result.status === 'missed') {
          setPhase('Call ended');
          cleanup();
          onClose();
          return;
        }
        for (const signal of result.signals) {
          if (!active || signal.id <= processedRef.current) continue;
          processedRef.current = signal.id;
          const pc = peerRef.current;
          if (!pc) break;
          if (signal.signal_type === 'offer' && !isCaller && !pc.remoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
            for (const ice of pendingIceRef.current.splice(0)) await pc.addIceCandidate(new RTCIceCandidate(ice));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await sendSignal('answer', answer);
          } else if (signal.signal_type === 'answer' && isCaller && !pc.remoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
            for (const ice of pendingIceRef.current.splice(0)) await pc.addIceCandidate(new RTCIceCandidate(ice));
          } else if (signal.signal_type === 'ice') {
            const ice = signal.payload as RTCIceCandidateInit;
            if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(ice));
            else pendingIceRef.current.push(ice);
          }
        }
      } catch { /* A temporary signaling miss should not terminate the call. */ }
      finally { pollingRef.current = false; }
    }
    const timer = window.setInterval(() => { void pollSignals(); }, 900);
    void pollSignals();
    return () => { active = false; window.clearInterval(timer); };
  }, [call.id, token, isCaller, sendSignal, cleanup, onClose]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
    if (remoteAudioRef.current && remoteStream) remoteAudioRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  function toggleMic() {
    const next = !micOn;
    localStreamRef.current?.getAudioTracks().forEach(track => { track.enabled = next; });
    setMicOn(next);
  }
  function toggleCamera() {
    const next = !cameraOn;
    localStreamRef.current?.getVideoTracks().forEach(track => { track.enabled = next; });
    setCameraOn(next);
  }

  const incoming = !isCaller && callStatus === 'ringing';
  return <div className="call-overlay">
    <div className="call-window">
      <div className="call-window-top"><span><LockKeyhole size={14} /> Peer-to-peer encrypted call</span><button className="icon-button" onClick={() => endCall(incoming ? 'decline' : 'end')}><X size={17} /></button></div>
      {incoming ? <div className="call-incoming"><div className="call-avatar"><Phone size={30} /></div><h2>Incoming {call.call_type} call</h2><p>Accept to connect directly.</p><div><button className="call-answer" onClick={answerCall}><Phone size={17} /> Answer</button><button className="call-decline" onClick={() => endCall('decline')}><PhoneOff size={17} /> Decline</button></div></div>
        : <div className="call-media-stage">
          <video ref={remoteVideoRef} autoPlay playsInline data-vyra-mute-lock="true" className={'call-remote-video ' + (call.call_type === 'audio' ? 'audio-only' : '')} />
          {call.call_type === 'audio' && <audio ref={remoteAudioRef} autoPlay />}
          <video ref={localVideoRef} autoPlay muted playsInline data-vyra-mute-lock="true" className="call-local-video" />
          {!remoteStream && <div className="call-connecting"><div className="call-avatar"><Avatar user={{username:'',display_name:'VYRA'}} size="xl" /></div><b>{phase}</b><small>Waiting for the other creator…</small></div>}
        </div>}
        <p className="call-network-note">Direct peer-to-peer WebRTC. Some restricted networks may need a TURN relay for calls to connect.</p>
      {!incoming && <div className="call-control-bar">
        <span>{phase}</span>
        <button className={!micOn ? 'off' : ''} onClick={toggleMic} aria-label="Toggle microphone">{micOn ? <Mic /> : <MicOff />}</button>
        {call.call_type === 'video' && <button className={!cameraOn ? 'off' : ''} onClick={toggleCamera} aria-label="Toggle camera">{cameraOn ? <Camera /> : <CameraOff />}</button>}
        <button className="call-hangup" onClick={() => endCall('end')} aria-label="End call"><PhoneOff /></button>
      </div>}
    </div>
  </div>;
}

function ReelsFeed({ posts, onLike, onProfile, onView, onComment, onShare, token, soundEnabled }: {
  posts: Post[];
  onLike: (post: Post) => void;
  onProfile: (user: User) => void;
  onView: (postId: string) => void;
  onComment: (post: Post, text: string) => Promise<void>;
  onShare: (post: Post) => void;
  token: string;
  soundEnabled: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const countedRef = useRef<Set<string>>(new Set());
  const [commentPost, setCommentPost] = useState<Post | null>(null);
  const postIdSignature = posts.map(post => post.id).join('|');
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const videos = Array.from(root.querySelectorAll<HTMLVideoElement>('video[data-post-id]'));
    const playWithPreferredSound = (video: HTMLVideoElement) => {
      video.muted = !soundEnabled;
      video.play().catch(() => {
        if (!soundEnabled) return;
        video.muted = true;
        void video.play().then(() => { video.muted = !soundEnabled; }).catch(() => undefined);
      });
    };
    if (!('IntersectionObserver' in window)) {
      if (videos[0]) playWithPreferredSound(videos[0]);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const video = entry.target as HTMLVideoElement;
        const id = video.dataset.postId || '';
        if (entry.isIntersecting && entry.intersectionRatio >= 0.65) {
          playWithPreferredSound(video);
          if (id && !countedRef.current.has(id)) {
            countedRef.current.add(id);
            onView(id);
          }
        } else video.pause();
      });
    }, { root, threshold: [0.1, 0.65, 0.9] });
    videos.forEach(video => observer.observe(video));
    return () => observer.disconnect();
  }, [postIdSignature, onView, soundEnabled]);

  if (!posts.length) return <div className="empty-card"><Clapperboard /><h3>No Reels yet.</h3><p>Be the first to bring the energy.</p></div>;
  return <>
    <div ref={scrollerRef} className="reels-scroller" aria-label="Vertical Reels feed">
      {posts.map(post => <article className="reel-screen" key={post.id}>
        <VYRAPlayer src={post.media_url} postId={post.id} soundEnabled={soundEnabled} autoPlay loop className="reel-video-player" showTimeline={false} />
        <div className="reel-shade" />
        <div className="reel-overlay">
          <button className="reel-author" onClick={() => onProfile(post.author)}>
            <Avatar user={post.author} size="sm" />
            <span>@{post.author.username} {post.author.is_verified && <VerifiedBadge />}</span>
          </button>
          {post.title && <b className="reel-title">{post.title}</b>}
          {post.caption && <p className="reel-caption">{post.caption}</p>}
          <div className="reel-stats"><span><Eye size={14} /> {(post.views_count || 0).toLocaleString()} views</span><span><Heart size={14} /> {post.likes_count.toLocaleString()}</span></div>
        </div>
        <div className="reel-side-actions">
          <button className={'reel-like ' + (post.liked ? 'liked' : '')} onClick={() => onLike(post)} aria-label="Like Reel">
            <Heart size={25} fill={post.liked ? 'currentColor' : 'none'} /><span>{post.likes_count.toLocaleString()}</span>
          </button>
          <button onClick={() => setCommentPost(post)} aria-label="View comments">
            <MessageCircle size={25} /><span>{post.comments_count.toLocaleString()}</span>
          </button>
          <button onClick={() => onShare(post)} aria-label="Share Reel with friends">
            <Send size={24} /><span>Share</span>
          </button>
          <button onClick={() => onProfile(post.author)} aria-label="Open creator profile"><Avatar user={post.author} size="sm" /></button>
        </div>
      </article>)}
    </div>
    {commentPost && <ShortCommentsSheet post={commentPost} token={token} onClose={() => setCommentPost(null)} onComment={onComment} />}
  </>;
}

function ProfileView({ profile, own, token, onRefresh }: { profile: User; own: boolean; token: string; onRefresh: () => void }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [editing, setEditing] = useState(false);
  const [display, setDisplay] = useState(profile.display_name);
  const [bio, setBio] = useState(profile.bio);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [deletingPostId, setDeletingPostId] = useState<string | null>(null);
  useEffect(() => { callApi<{ posts: Post[] }>('profile-posts', { username: profile.username }, token).then(r => setPosts(r.posts)).catch(e => setMessage(e.message)); }, [profile.username, token]);
  async function removeCreatorVideo(post: Post) {
    if (!own || post.media_type !== 'video' || deletingPostId) return;
    if (!window.confirm('Delete this video from your creator wall? This cannot be undone.')) return;
    setDeletingPostId(post.id);
    setMessage('');
    try {
      const result = await callApi<{ ok: boolean; storageCleanupPending?: boolean }>('delete-own-post', { postId: post.id }, token);
      setPosts(items => items.filter(item => item.id !== post.id));
      onRefresh();
      setMessage(result.storageCleanupPending
        ? 'Video deleted. Its stored media file needs a cleanup retry.'
        : 'Video deleted from your creator wall.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not delete this video.');
    } finally { setDeletingPostId(null); }
  }
  async function save() {
    setBusy(true); setMessage('');
    try { await callApi('update-profile', { displayName: display, bio }, token); setEditing(false); onRefresh(); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Could not update profile.'); }
    finally { setBusy(false); }
  }
  async function avatar(file?: File) {
    if (!file) return;
    setBusy(true);
    try { await uploadMedia(file, 'avatar', token); onRefresh(); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Avatar upload failed.'); }
    finally { setBusy(false); }
  }
  return <section className="profile-view"><div className="profile-hero"><div className="profile-avatar-wrap"><Avatar user={profile} size="xl" ring={profile.is_verified} />{own && <label className="avatar-edit"><Plus size={14} /><input type="file" accept="image/*" onChange={e => avatar(e.target.files?.[0])} /></label>}</div>
    <div className="profile-main"><div className="profile-title"><h2>{profile.username} {profile.is_verified && <VerifiedBadge size="md" />}</h2>{own && <button className="button button-soft" onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit profile'}</button>}</div>
      <div className="profile-stats"><span><b>{profile.posts_count}</b> posts</span><span><b>{profile.follower_count.toLocaleString()}</b> followers</span><span><b>{profile.following_count.toLocaleString()}</b> following</span></div>
      {!editing && <><b>{profile.display_name}</b><p>{profile.bio || 'Creating my own little corner of the internet.'}</p><span className="verified-caption">{profile.is_verified ? 'Verified creator' : 'Creator on the rise'}</span></>}
      {editing && <div className="edit-profile"><label>Display name<input value={display} onChange={e => setDisplay(e.target.value)} maxLength={60} /></label><label>Bio<textarea rows={3} value={bio} onChange={e => setBio(e.target.value)} maxLength={300} /></label><button className="button button-primary" onClick={save} disabled={busy}>Save changes</button></div>}
      {message && <div className="form-error">{message}</div>}
    </div></div><div className="profile-posts-head"><span>THE CREATOR WALL</span><span>{posts.length} moments</span></div>
    {posts.length ? <div className="profile-grid">{posts.map(p => <div key={p.id} className="profile-tile">{p.media_type === 'video' ? <video src={p.media_url} muted playsInline preload="metadata" /> : <img src={p.media_url} alt={p.caption} />}<span><Heart size={14} fill="currentColor" /> {p.likes_count}</span>{own && p.media_type === 'video' && <button type="button" className="profile-tile-delete" title="Delete your video" aria-label="Delete your video" disabled={deletingPostId === p.id || !!deletingPostId} onClick={() => void removeCreatorVideo(p)}>{deletingPostId === p.id ? <RefreshCw size={15} className="spin" /> : <Trash2 size={15} />}</button>}</div>)}</div> : <div className="empty-card compact"><Sparkles size={25} /><h3>Space for your next big moment.</h3><p>Approved posts will find a home on this wall.</p></div>}
  </section>;
}


function DirectMessages({ token, user, target, onClearTarget, onToast, onIdentityReady, onStartCall }: {
  token: string; user: User; target: User | null; onClearTarget: () => void;
  onToast: (message: string) => void; onIdentityReady: (identity: E2EEIdentity | null) => void;
  onStartCall: (call: any) => void;
}) {
  const [conversations, setConversations] = useState<DMConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inboxSearch, setInboxSearch] = useState('');
  const [syncStatus, setSyncStatus] = useState<'syncing' | 'live' | 'reconnecting'>('syncing');
  const [messages, setMessages] = useState<DMMessage[]>([]);
  const [composeTarget, setComposeTarget] = useState<User | null>(null);
  const [composer, setComposer] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [keyLoading, setKeyLoading] = useState(true);
  const [keyState, setKeyState] = useState<'missing' | 'locked' | 'ready'>('missing');
  const [storedKey, setStoredKey] = useState<StoredE2EEIdentity | null>(null);
  const [identity, setIdentity] = useState<E2EEIdentity | null>(null);
  const [password, setPassword] = useState('');
  const [keyError, setKeyError] = useState('');
  const [decoded, setDecoded] = useState<Record<string, string>>({});
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});
  const [safetyCode, setSafetyCode] = useState('');
  const [showSafetyCode, setShowSafetyCode] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const peerKeyCache = useRef<Map<string, CryptoKey>>(new Map());

  const loadInbox = useCallback(async () => {
    const result = await callApi<{ conversations: DMConversation[] }>('dm-inbox', {}, token);
    setConversations(result.conversations);
    setSyncStatus('live');
  }, [token]);

  useEffect(() => {
    let active = true;
    callApi<{ key: (StoredE2EEIdentity & { username: string }) | null }>('e2ee-key-get', { username: user.username }, token)
      .then(result => {
        if (!active) return;
        if (result.key) {
          setStoredKey(result.key);
          setKeyState('locked');
        } else {
          setStoredKey(null);
          setKeyState('missing');
        }
      })
      .catch(error => { if (active) setKeyError(error instanceof Error ? error.message : 'Secure messaging is unavailable.'); })
      .finally(() => { if (active) setKeyLoading(false); });
    return () => { active = false; };
  }, [token, user.username]);

  useEffect(() => {
    loadInbox().catch(error => onToast(error instanceof Error ? error.message : 'Could not load messages.'))
      .finally(() => setLoading(false));
    const refresh = window.setInterval(() => loadInbox().catch(() => setSyncStatus('reconnecting')), 5000);
    return () => window.clearInterval(refresh);
  }, [loadInbox, onToast]);

  useEffect(() => {
    if (!target) return;
    setComposeTarget(target);
    setSelectedId(null);
    setMessages([]);
    setComposer('');
    onClearTarget();
  }, [target]);

  useEffect(() => {
    if (!selectedId) { setMessages([]); return; }
    let active = true;
    const loadMessages = async () => {
      const result = await callApi<{ messages: DMMessage[] }>('dm-messages', { conversationId: selectedId }, token);
      if (active) {
        setMessages(current => current.length === result.messages.length
          && current.every((message, index) => message.id === result.messages[index]?.id)
          ? current : result.messages);
        setSyncStatus('live');
      }
    };
    loadMessages().catch(error => {
      setSyncStatus('reconnecting');
      onToast(error instanceof Error ? error.message : 'Could not load this chat.');
    });
    const refresh = window.setInterval(() => loadMessages().catch(() => setSyncStatus('reconnecting')), 3500);
    return () => { active = false; window.clearInterval(refresh); };
  }, [selectedId, token, onToast]);

  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages, selectedId]);

  const selected = conversations.find(item => item.id === selectedId) || null;
  const selectedPeerUsername = selected?.otherUser.username || '';
  const selectedAccepted = selected?.status === 'accepted';
  useEffect(() => {
    let active = true;
    setShowSafetyCode(false);
    if (!identity || !selectedId || !selectedPeerUsername || !selectedAccepted) {
      setSafetyCode('');
      return () => { active = false; };
    }
    callApi<{ key: { publicKey: JsonWebKey } | null }>('e2ee-key-get', { username: selectedPeerUsername }, token)
      .then(async result => {
        if (!result.key?.publicKey) throw new Error('The other creator has not enabled secure messaging.');
        const code = await conversationSafetyCode(identity.publicKey, result.key.publicKey, selectedId);
        if (active) setSafetyCode(code);
      })
      .catch(() => { if (active) setSafetyCode('Unavailable'); });
    return () => { active = false; };
  }, [identity, selectedId, selectedPeerUsername, selectedAccepted, token]);
  const incoming = conversations.filter(item => item.status === 'pending' && item.requester_id !== user.id);
  const sent = conversations.filter(item => item.status === 'pending' && item.requester_id === user.id);
  const chats = conversations.filter(item => item.status === 'accepted');
  const matchesInbox = (item: DMConversation) => !inboxSearch.trim()
    || item.otherUser.username.toLowerCase().includes(inboxSearch.trim().replace(/^@/, '').toLowerCase());

  async function unlockOrCreateKeys(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setKeyError('');
    try {
      if (storedKey) {
        const opened = await unlockE2EEIdentity(user.id, password, storedKey);
        setIdentity(opened);
        onIdentityReady(opened);
      } else {
        const created = await createE2EEIdentity(user.id, password);
        await callApi('e2ee-key-set', {
          publicKey: created.stored.publicKey,
          wrappedPrivateKey: created.stored.wrappedPrivateKey,
          salt: created.stored.salt,
          iv: created.stored.iv,
        }, token);
        setStoredKey(created.stored);
        setIdentity(created.identity);
        setKeyState('ready');
        onIdentityReady(created.identity);
      }
      setPassword('');
      setKeyState('ready');
      peerKeyCache.current.clear();
      await loadInbox();
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : 'Could not unlock secure messaging.');
    } finally { setBusy(false); }
  }

  function lockKeys() {
    setIdentity(null);
    setKeyState(storedKey ? 'locked' : 'missing');
    setDecoded({});
    setAttachmentUrls({});
    peerKeyCache.current.clear();
    onIdentityReady(null);
  }

  async function getPeerPublicKey(peer: User): Promise<JsonWebKey> {
    if (!identity) throw new Error('Unlock secure messaging first.');
    const result = await callApi<{ key: { publicKey: JsonWebKey } | null }>('e2ee-key-get', { username: peer.username }, token);
    if (!result.key?.publicKey) throw new Error('@' + peer.username + ' needs to enable secure messaging before you can chat.');
    return result.key.publicKey;
  }

  async function getConversationKey(conversation: DMConversation): Promise<CryptoKey> {
    if (!identity) throw new Error('Unlock secure messaging first.');
    const cached = peerKeyCache.current.get(conversation.id);
    if (cached) return cached;
    const publicKey = await getPeerPublicKey(conversation.otherUser);
    const key = await deriveConversationKey(identity, publicKey, conversation.id);
    peerKeyCache.current.set(conversation.id, key);
    return key;
  }

  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    async function decryptVisibleMessages() {
      if (!identity || !selected) { setDecoded({}); setAttachmentUrls({}); return; }
      try {
        const key = await getConversationKey(selected);
        const textMap: Record<string, string> = {};
        const urlMap: Record<string, string> = {};
        for (const message of messages) {
          if (message.e2ee_version === 1) {
            try { textMap[message.id] = await decryptText(message.content, key); }
            catch { textMap[message.id] = 'Unable to decrypt this message. Check that both devices use the same encryption key.'; }
          } else {
            textMap[message.id] = message.content + '  ·  Older message, not end-to-end encrypted';
          }
          if (message.media_url && message.attachment_iv && message.attachment_mime) {
            try {
              const response = await fetch(message.media_url);
              if (!response.ok) throw new Error('Encrypted file unavailable');
              const ciphertext = await response.blob();
              const plain = await decryptFile(ciphertext, message.attachment_iv, key, selected.id, message.attachment_mime);
              const url = URL.createObjectURL(plain);
              urls.push(url);
              urlMap[message.id] = url;
            } catch {
              textMap[message.id] = 'Encrypted attachment could not be opened on this device.';
            }
          }
        }
        if (active) { setDecoded(textMap); setAttachmentUrls(urlMap); }
      } catch (error) {
        if (active) onToast(error instanceof Error ? error.message : 'Could not decrypt this conversation.');
      }
    }
    void decryptVisibleMessages();
    return () => { active = false; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [identity, selectedId, messages, token]);

  async function sendRequest(event: FormEvent) {
    event.preventDefault();
    if (!composeTarget || !composer.trim()) return;
    if (!identity) { onToast('Unlock secure messaging first.'); return; }
    setBusy(true);
    try {
      const result = await callApi<{ conversationId: string; status: string }>('dm-start', { username: composeTarget.username }, token);
      if (result.status === 'incoming') {
        await loadInbox();
        setComposeTarget(null);
        setSelectedId(result.conversationId);
        onToast('This creator has already requested to message you. Review the request.');
        return;
      }
      const peerPublic = await getPeerPublicKey(composeTarget);
      const key = await deriveConversationKey(identity, peerPublic, result.conversationId);
      const encrypted = await encryptText(composer.trim(), key);
      if (result.status === 'accepted') {
        await callApi('dm-send', { conversationId: result.conversationId, content: encrypted, messageType: 'text' }, token);
      } else {
        await callApi('dm-request-send', { conversationId: result.conversationId, content: encrypted }, token);
      }
      setComposer('');
      setComposeTarget(null);
      await loadInbox();
      setSelectedId(result.conversationId);
      onToast(result.status === 'pending' ? 'Encrypted message request sent.' : 'Encrypted message sent.');
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not send message request.');
    } finally { setBusy(false); }
  }

  async function respond(decision: 'accept' | 'decline') {
    if (!selectedId) return;
    setBusy(true);
    try {
      await callApi('dm-respond', { conversationId: selectedId, decision }, token);
      await loadInbox();
      if (decision === 'decline') { setSelectedId(null); setMessages([]); }
      else {
        const result = await callApi<{ messages: DMMessage[] }>('dm-messages', { conversationId: selectedId }, token);
        setMessages(result.messages);
      }
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not update this request.'); }
    finally { setBusy(false); }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!selected || !composer.trim() || !identity) return;
    setBusy(true);
    try {
      const text = composer.trim();
      const key = await getConversationKey(selected);
      const content = await encryptText(text, key);
      setComposer('');
      const result = await callApi<{ message: DMMessage }>('dm-send', { conversationId: selected.id, content, messageType: 'text' }, token);
      setMessages(current => [...current.filter(message => message.id !== result.message.id), result.message]
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()));
      setSyncStatus('live');
      await loadInbox();
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Message could not be sent.');
    }
    finally { setBusy(false); }
  }

  async function sendAttachment(file: Blob, messageType: 'image' | 'voice', mime: string) {
    if (!selected || selected.status !== 'accepted' || !identity) throw new Error('Unlock secure messages and select an accepted chat first.');
    if (file.size > 15 * 1024 * 1024) throw new Error('Attachments must be 15 MB or smaller.');
    setBusy(true);
    try {
      const key = await getConversationKey(selected);
      const encryptedFile = await encryptFile(file, key, selected.id);
      const path = await uploadEncryptedAttachment(encryptedFile.blob, selected.id, token, messageType, mime);
      const encryptedCaption = await encryptText(messageType === 'image' ? 'Photo' : 'Voice note', key);
      await callApi('dm-send', {
        conversationId: selected.id, content: encryptedCaption, messageType,
        attachmentPath: path, attachmentIv: encryptedFile.iv, attachmentMime: mime,
      }, token);
      const result = await callApi<{ messages: DMMessage[] }>('dm-messages', { conversationId: selected.id }, token);
      setMessages(result.messages);
      await loadInbox();
    } finally { setBusy(false); }
  }

  async function choosePhoto(file?: File) {
    if (!file) return;
    try {
      if (!file.type.startsWith('image/')) throw new Error('Choose an image to share.');
      await sendAttachment(file, 'image', file.type);
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not share photo.'); }
    if (photoInputRef.current) photoInputRef.current.value = '';
  }

  async function toggleRecording() {
    if (isRecording) {
      recorderRef.current?.stop();
      setIsRecording(false);
      return;
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Voice recording is not available in this browser.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const mime = (blob.type || 'audio/webm').split(';')[0];
        recordingStreamRef.current?.getTracks().forEach(track => track.stop());
        recordingStreamRef.current = null;
        void sendAttachment(blob, 'voice', mime).catch(error => onToast(error instanceof Error ? error.message : 'Voice note failed.'));
      };
      recorder.start();
      setIsRecording(true);
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not start recording.'); }
  }

  useEffect(() => () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    recordingStreamRef.current?.getTracks().forEach(track => track.stop());
  }, []);

  async function startCall(callType: 'audio' | 'video') {
    if (!selected || selected.status !== 'accepted') return;
    try {
      const result = await callApi<{ call: any }>('dm-call-start', { conversationId: selected.id, callType }, token);
      onStartCall(result.call);
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not start call.'); }
  }

  const conversationButton = (item: DMConversation, label?: string) =>
    <button key={item.id} className={'dm-list-item ' + (selectedId === item.id ? 'active' : '')} onClick={() => { setComposeTarget(null); setSelectedId(item.id); }}>
      <Avatar user={item.otherUser} size="md" />
      <span className="dm-list-copy"><b>@{item.otherUser.username} {item.otherUser.is_verified && <VerifiedBadge />}</b><small>{label || item.last_message?.preview || 'Encrypted chat'}</small></span>
      <small className="dm-list-time">{ago(item.last_message_at)}</small>
    </button>;

  return <section className="content-page dm-page">
    <div className="page-intro dm-page-intro"><p className="eyebrow">PRIVATE BY DESIGN</p><h2>Your messages.</h2><p>New messages, photos and voice notes are encrypted on this device before being sent.</p></div>
    {keyState !== 'ready' && <form className="e2ee-unlock-card" onSubmit={unlockOrCreateKeys}>
      <div className="e2ee-lock-icon"><LockKeyhole size={23} /></div>
      <div className="e2ee-copy"><b>{keyState === 'missing' ? 'Set up secure messaging' : 'Unlock your encrypted messages'}</b>
        <small>{storedKey ? 'Enter your VYRA password to unlock your private key on this device.' : 'Your private key is generated on this device and stored only as a password-encrypted backup.'}</small>
      </div>
      <label><span>VYRA password</span><input type="password" value={password} onChange={event => setPassword(event.target.value)} required minLength={10} autoComplete="current-password" /></label>
      {keyError && <div className="form-error">{keyError}</div>}
      <button className="button button-primary" disabled={busy || keyLoading}>{busy ? 'Securing…' : storedKey ? 'Unlock messages' : 'Create encryption key'}</button>
    </form>}
    {keyState === 'ready' && <div className="e2ee-status"><LockKeyhole size={14} /><span>End-to-end encryption is enabled for new messages.</span><button onClick={lockKeys}>Lock</button></div>}
    <div className="dm-layout">
      <aside className="dm-inbox">
        <div className="dm-inbox-head"><b>Inbox</b><button className="icon-button" onClick={() => loadInbox().catch(() => setSyncStatus('reconnecting'))} aria-label="Refresh inbox"><RefreshCw size={16} /></button></div>
        <div className="dm-inbox-search"><Search size={15} /><input value={inboxSearch} onChange={event => setInboxSearch(event.target.value)} placeholder="Search people or chats" aria-label="Search conversations" /></div>
        {loading && <p className="dm-empty-note">Loading your inbox…</p>}
        {incoming.filter(matchesInbox).length > 0 && <div className="dm-group"><h4>MESSAGE REQUESTS <span>{incoming.filter(matchesInbox).length}</span></h4>{incoming.filter(matchesInbox).map(item => conversationButton(item, 'Message request'))}</div>}
        {sent.filter(matchesInbox).length > 0 && <div className="dm-group"><h4>SENT REQUESTS</h4>{sent.filter(matchesInbox).map(item => conversationButton(item, 'Waiting for acceptance'))}</div>}
        <div className="dm-group"><h4>CHATS</h4>{chats.filter(matchesInbox).map(item => conversationButton(item))}</div>
        {!loading && conversations.length === 0 && <p className="dm-empty-note">No messages yet. Open a creator profile and choose Message to start a request.</p>}
        {!loading && conversations.length > 0 && !conversations.some(matchesInbox) && <p className="dm-empty-note">No conversations match that search.</p>}
      </aside>

      <section className="dm-thread">
        {composeTarget ? <>
          <div className="dm-thread-head"><Avatar user={composeTarget} size="md" /><div><b>@{composeTarget.username} {composeTarget.is_verified && <VerifiedBadge />}</b><small>New message request · encrypted</small></div></div>
          <div className="dm-request-intro"><LockKeyhole size={28} /><h3>Start a private conversation.</h3><p>Your message is encrypted before leaving your device. They must accept before the chat opens.</p></div>
          <form className="dm-compose" onSubmit={sendRequest}><textarea rows={3} value={composer} onChange={event => setComposer(event.target.value)} maxLength={1000} placeholder={'Write a message to @' + composeTarget.username + '…'} disabled={!identity} /><button className="button button-primary" disabled={busy || !composer.trim() || !identity}><Send size={16} /> Send request</button></form>
        </> : selected ? <>
          <div className="dm-thread-head">
            <Avatar user={selected.otherUser} size="md" />
            <div className="dm-thread-title"><b>@{selected.otherUser.username} {selected.otherUser.is_verified && <VerifiedBadge />}</b><small>{selected.status === 'accepted' ? 'End-to-end encrypted chat' : selected.requester_id === user.id ? 'Request sent · waiting for acceptance' : 'Encrypted message request'}</small></div>
            {selected.status === 'accepted' && <span className={'dm-sync-pill dm-sync-' + syncStatus}><i />{syncStatus === 'live' ? 'Live' : syncStatus === 'syncing' ? 'Syncing' : 'Reconnecting'}</span>}
            {selected.status === 'accepted' && <div className="dm-call-actions"><button className="icon-button" title="Audio call" onClick={() => startCall('audio')}><Phone size={19} /></button><button className="icon-button" title="Video call" onClick={() => startCall('video')}><Video size={20} /></button></div>}
          </div>
          {selected.status === 'pending' && selected.requester_id !== user.id && <div className="dm-request-banner"><div><b>Accept this message request?</b><small>Accept to open the private chat. Declining keeps the chat closed.</small></div><div><button className="button button-primary" disabled={busy} onClick={() => respond('accept')}>Accept</button><button className="button button-soft" disabled={busy} onClick={() => respond('decline')}>Decline</button></div></div>}
          <button type="button" className="dm-encryption-note dm-safety-toggle" onClick={() => setShowSafetyCode(value => !value)}>
            <LockKeyhole size={12} /> End-to-end encrypted · {showSafetyCode ? 'Hide' : 'Compare safety code'}
          </button>
          {showSafetyCode && <div className="dm-safety-code">
            <small>Conversation safety code</small>
            <strong>{safetyCode || 'Generating…'}</strong>
            <p>Ask @{selected.otherUser.username} to open this same panel on their device and compare all groups using another trusted channel. A mismatch means you should not send sensitive information.</p>
          </div>}
          <div className="dm-messages" ref={messagesRef} aria-live="polite" aria-relevant="additions">
            {messages.map((message, messageIndex) => <div key={message.id} className={'dm-bubble-row ' + (message.sender_id === user.id ? 'mine' : '') + (messages[messageIndex - 1]?.sender_id === message.sender_id ? ' grouped' : '')}>
              <div className="dm-bubble">
                {message.message_type === 'shared_post' && message.shared_post && <div className="dm-shared-post">
                  {message.shared_post.media_type === 'video' ? <video src={message.shared_post.media_url} muted playsInline /> : <img src={message.shared_post.media_url} alt="Shared post" />}
                  <b>@{message.shared_post.author.username}</b><p>{message.shared_post.caption}</p><small>Shared from VYRA</small>
                </div>}
                {message.message_type === 'image' && attachmentUrls[message.id] && <img className="dm-attachment-image" src={attachmentUrls[message.id]} alt="End-to-end encrypted photo" />}
                {message.message_type === 'voice' && attachmentUrls[message.id] && <audio className="dm-voice-player" controls src={attachmentUrls[message.id]} />}
                {message.e2ee_version === 1 && !decoded[message.id] ? <p className="dm-decrypting">Decrypting…</p> : <p>{decoded[message.id] || (message.e2ee_version === 1 ? '🔒 Unlock secure messaging to read this.' : message.content)}</p>}
                <small>{ago(message.created_at)} {message.e2ee_version === 1 && <LockKeyhole size={10} />}</small>
              </div>
            </div>)}
          </div>
          {selected.status === 'accepted' ? <form className="dm-compose dm-compose-inline" onSubmit={sendMessage}>
            <input ref={photoInputRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={event => choosePhoto(event.target.files?.[0])} />
            <button type="button" className="dm-attach-btn" title="Send an encrypted photo" onClick={() => photoInputRef.current?.click()} disabled={!identity || busy}><Image size={19} /></button>
            <button type="button" className={'dm-attach-btn ' + (isRecording ? 'recording' : '')} title={isRecording ? 'Stop voice note' : 'Record voice note'} onClick={toggleRecording} disabled={!identity || busy}>{isRecording ? <MicOff size={19} /> : <Mic size={19} />}</button>
            <textarea rows={2} value={composer} onChange={event => setComposer(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} maxLength={1000} placeholder={identity ? 'Message… (Enter to send, Shift + Enter for a new line)' : 'Unlock secure messaging to chat'} disabled={!identity || busy} />
            <button className="button button-primary dm-send-button" disabled={busy || !composer.trim() || !identity} aria-label="Send encrypted message"><Send size={17} /></button>
          </form> : selected.requester_id === user.id
            ? <p className="dm-closed-note">Your request is waiting for @ {selected.otherUser.username} to accept. You can chat here after approval.</p>
            : <p className="dm-closed-note">This conversation stays closed until you accept the request.</p>}
        </> : <div className="dm-no-selection"><MessageCircle size={34} /><h3>Your conversations live here.</h3><p>Choose a message request or accepted chat, or visit a creator profile to send the first message.</p></div>}
      </section>
    </div>
  </section>;
}

function AdminPanel({ token, onClose }: { token: string; onClose: () => void }) {
  const [summary, setSummary] = useState<any>(null);
  const [username, setUsername] = useState('');
  const [hash, setHash] = useState('');
  const [holder, setHolder] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [channels, setChannels] = useState<any[]>([]);
  const [channelName, setChannelName] = useState('');
  const [channelQuery, setChannelQuery] = useState('');
  const [youtubeChannelId, setYoutubeChannelId] = useState('');
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [candidateChannelName, setCandidateChannelName] = useState('');
  const [rightsFile, setRightsFile] = useState<File | null>(null);
  const [rightsCaption, setRightsCaption] = useState('');
  const [rightsSourceUrl, setRightsSourceUrl] = useState('');
  const [rightsHolder, setRightsHolder] = useState('');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const load = useCallback(async () => {
    const [adminSummary, channelResult] = await Promise.all([
      callApi<any>('admin-summary', {}, token),
      callApi<{ channels: any[] }>('admin-discovery-channels', {}, token),
    ]);
    setSummary(adminSummary); setChannels(channelResult.channels || []);
  }, [token]);
  useEffect(() => { load().catch(error => setMessage(error.message)); }, [load]);
  async function action(actionName: string, payload: Record<string, unknown>) {
    setBusy(true); setMessage('');
    try { await callApi(actionName, payload, token); await load(); setMessage('Saved.'); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Action failed.'); }
    finally { setBusy(false); }
  }
  async function createChannel(event: FormEvent) {
    event.preventDefault();
    if (!channelName.trim() || !channelQuery.trim()) return;
    setBusy(true); setMessage('');
    try {
      await callApi('admin-discovery-channel-create', {
        name: channelName.trim(), searchQuery: channelQuery.trim(), youtubeChannelId: youtubeChannelId.trim(),
      }, token);
      setChannelName(''); setChannelQuery(''); setYoutubeChannelId('');
      await load(); setMessage('Discovery channel created.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not create channel.'); }
    finally { setBusy(false); }
  }
  async function scanChannel(channel: any) {
    setScanningId(channel.id); setCandidates([]); setCandidateChannelName(channel.name); setMessage('');
    try {
      const result = await callApi<{ videos: any[] }>('admin-content-discover', { channelId: channel.id }, token);
      setCandidates(result.videos || []);
      if (!result.videos?.length) setMessage('No matching videos found for this channel.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Discovery scan failed.'); }
    finally { setScanningId(null); }
  }
  async function deleteChannel(channel: any) {
    setBusy(true); setMessage('');
    try {
      await callApi('admin-discovery-channel-delete', { channelId: channel.id }, token);
      await load();
      if (candidateChannelName === channel.name) { setCandidates([]); setCandidateChannelName(''); }
      setMessage('Discovery channel deleted.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not delete channel.'); }
    finally { setBusy(false); }
  }
  async function publishRightsCleared(event: FormEvent) {
    event.preventDefault();
    if (!rightsFile || !rightsHolder.trim() || !rightsSourceUrl.trim() || !rightsConfirmed) {
      setMessage('Choose the original video, add its source and rights holder, and confirm permission.'); return;
    }
    if (!rightsFile.type.startsWith('video/')) { setMessage('Choose an MP4 or WebM video file.'); return; }
    setPublishing(true); setMessage('');
    try {
      const duration = await videoDuration(rightsFile);
      await uploadMedia(rightsFile, 'post', token, {
        caption: rightsCaption.trim(), durationSeconds: duration, category: classifyVideo(duration),
        adminCurated: true, sourceUrl: rightsSourceUrl.trim(), rightsHolder: rightsHolder.trim(),
        rightsConfirmation: 'I confirm VYRA has written permission or a valid licence to host and distribute this video.',
      });
      setRightsFile(null); setRightsCaption(''); setRightsSourceUrl(''); setRightsHolder(''); setRightsConfirmed(false);
      await load(); setMessage('Rights-cleared video published to VYRA.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not publish the video.'); }
    finally { setPublishing(false); }
  }
  return <section className="admin-view"><div className="admin-top"><div><p className="eyebrow">VYRA CONTROL ROOM</p><h2>Creator operations</h2><p>Moderation, discovery and world spotlight.</p></div><button className="button button-soft" onClick={onClose}>Close panel <X size={15} /></button></div>
    {summary && <div className="admin-stats"><div><span>Pending review</span><b>{summary.pendingPosts?.length || 0}</b></div><div><span>Creators</span><b>{summary.userCount || 0}</b></div><div><span>Verified</span><b>{summary.verifiedCount || 0}</b></div></div>}
    {message && <div className="notice-success">{message}</div>}
    <div className="admin-section discovery-section">
      <div className="section-title"><h3>VYRA Scout · content discovery</h3><span>Admin-only · on-demand scan</span></div>
      <p className="microcopy">Create search channels by topic or YouTube creator. VYRA queries the official API and displays source metadata and links only. Search results are temporary and are not copied into VYRA.</p>
      <form className="discovery-channel-form" onSubmit={createChannel}>
        <label>CHANNEL NAME<input value={channelName} onChange={event => setChannelName(event.target.value)} maxLength={50} placeholder="Daily tech discoveries" /></label>
        <label>SEARCH PHRASE<input value={channelQuery} onChange={event => setChannelQuery(event.target.value)} maxLength={120} placeholder="technology, science and creative short videos" /></label>
        <label>OPTIONAL YOUTUBE CHANNEL ID<input value={youtubeChannelId} onChange={event => setYoutubeChannelId(event.target.value)} placeholder="UCxxxxxxxxxxxxxxxxxxxxxx" /></label>
        <button className="button button-primary" disabled={busy || !channelName.trim() || !channelQuery.trim()}>Create channel</button>
      </form>
      <div className="discovery-channel-list">
        {channels.length ? channels.map(channel => <div className="discovery-channel-row" key={channel.id}>
          <div><b>{channel.name}</b><small>{channel.search_query}{channel.youtube_channel_id ? ' · channel filtered' : ' · broad search'}</small></div>
          <button className="button button-soft" onClick={() => scanChannel(channel)} disabled={!!scanningId || busy}>{scanningId === channel.id ? 'Scanning…' : 'Scan YouTube'}</button>
          <button className="icon-button" onClick={() => deleteChannel(channel)} disabled={busy || !!scanningId} aria-label={'Delete ' + channel.name}><X size={16} /></button>
        </div>) : <p className="microcopy">No discovery channels yet. Create one above to start a scan.</p>}
      </div>
      {candidateChannelName && <div className="discovery-results-head"><b>Results · {candidateChannelName}</b><span>{candidates.length} suggestions</span></div>}
      {candidates.length > 0 && <div className="discovery-candidates">{candidates.map(item => <article className="discovery-candidate" key={item.videoId}>
        <img src={item.thumbnailUrl} alt="" loading="lazy" />
        <div><b>{item.title}</b><small>{item.channelTitle} · {item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : 'Date unavailable'}</small><a href={item.sourceUrl} target="_blank" rel="noreferrer">Open original on YouTube ↗</a></div>
      </article>)}</div>}
      <div className="discovery-legal-note">Important: Creative Commons search results are not a YouTube download permission. Contact the rights holder and obtain permission before importing any original video file into VYRA.</div>
      <p className="microcopy">Configure <b>YOUTUBE_API_KEY</b> in Supabase → Edge Functions → Secrets before the first scan. Other platforms need their approved APIs or creator-supplied original files; this does not scrape them.</p>
    </div>
    <div className="admin-section rights-import-section">
      <div className="section-title"><h3>Publish a licensed video</h3><span>Original file + recorded permission</span></div>
      <form className="rights-import-form" onSubmit={publishRightsCleared}>
        <label>ORIGINAL VIDEO FILE<input type="file" accept="video/mp4,video/webm" onChange={event => setRightsFile(event.target.files?.[0] || null)} /></label>
        <label>CREATOR / RIGHTS HOLDER<input value={rightsHolder} onChange={event => setRightsHolder(event.target.value)} maxLength={160} placeholder="Creator name or licence owner" /></label>
        <label>ORIGINAL SOURCE URL<input type="url" value={rightsSourceUrl} onChange={event => setRightsSourceUrl(event.target.value)} placeholder="https://..." /></label>
        <label>VYRA CAPTION<textarea rows={2} value={rightsCaption} onChange={event => setRightsCaption(event.target.value)} maxLength={2200} placeholder="Add context for the VYRA feed" /></label>
        <label className="check-line"><input type="checkbox" checked={rightsConfirmed} onChange={event => setRightsConfirmed(event.target.checked)} /> I confirm VYRA has written permission or a valid licence to host and distribute this video.</label>
        <button className="button button-primary" disabled={publishing || !rightsFile || !rightsHolder.trim() || !rightsSourceUrl.trim() || !rightsConfirmed}>{publishing ? 'Checking and publishing…' : 'Publish licensed video to VYRA'}</button>
      </form>
      <p className="microcopy">The upload is checked against VYRA’s exact-file fingerprint registry. The source URL, rights holder and permission attestation are recorded in the admin audit log.</p>
    </div>
    <div className="admin-section"><div className="section-title"><h3>Verification desk</h3><span>Grant verified status by exact username</span></div><div className="inline-action"><input value={username} onChange={e => setUsername(e.target.value)} placeholder="Creator username" /><button className="button button-primary" onClick={() => action('admin-verify', { username })} disabled={!username.trim() || busy}>Verify creator</button></div></div>
    <div className="admin-section"><div className="section-title"><h3>Copyright fingerprint register</h3><span>Exact SHA-256 file matching only</span></div><div className="form-stack"><input value={hash} onChange={e => setHash(e.target.value)} placeholder="64-character SHA-256 hash" /><input value={holder} onChange={e => setHolder(e.target.value)} placeholder="Rights holder / source label" /><button className="button button-soft" onClick={() => action('admin-add-fingerprint', { sha256: hash, rightsHolder: holder })} disabled={busy || hash.length !== 64 || !holder.trim()}>Register exact match</button></div><p className="microcopy">An exact SHA-256 match blocks that exact file; it will not identify edited or cropped copies.</p></div>
    <div className="admin-section"><div className="section-title"><h3>Moderation queue</h3><span>Unknown uploads stay out of public feeds</span></div>
      {summary?.pendingPosts?.length ? summary.pendingPosts.map((post: any) => <div className="review-row" key={post.id}><div className="review-thumb">{post.media_type === 'video' ? <video src={post.media_url} muted /> : <img src={post.media_url} alt="" />}</div><div className="review-details"><b>@{post.author?.username || 'creator'} · {post.kind}</b><p>{post.caption || 'No caption'} · {post.copyright_status}</p></div><div className="review-actions"><button onClick={() => action('admin-moderate', { postId: post.id, decision: 'approve' })}>Approve</button><button className="danger-text" onClick={() => action('admin-moderate', { postId: post.id, decision: 'block' })}>Block</button><button onClick={() => action('admin-feature', { postId: post.id, featured: true })}>World feed</button></div></div>) : <div className="empty-card compact"><ShieldCheck size={25} /><h3>Queue is clear.</h3><p>New submissions will appear here for review.</p></div>}
    </div>
    <div className="admin-section"><div className="section-title"><h3>Story moderation</h3><span>Approve or block 24-hour stories</span></div>
      {summary?.pendingStories?.length ? summary.pendingStories.map((story: any) => <div className="review-row" key={story.id}>
        <div className="review-thumb">{story.media_type === 'video' ? <video src={story.media_url} /> : <img src={story.media_url} alt="" />}</div>
        <div className="review-details"><b>@{story.author?.username || 'creator'} · story</b><p>{story.caption || 'No caption'} · {story.copyright_status}</p></div>
        <div className="review-actions"><button onClick={() => action('admin-moderate-story', { storyId: story.id, decision: 'approve' })}>Approve</button><button className="danger-text" onClick={() => action('admin-moderate-story', { storyId: story.id, decision: 'block' })}>Block</button></div>
      </div>) : <p className="microcopy">No stories waiting for review.</p>}
    </div>
    <div className="admin-section"><div className="section-title"><h3>World spotlight</h3><span>Only approved creator videos can be featured</span></div>
      {summary?.approvedPosts?.length ? summary.approvedPosts.map((post: any) => <div className="review-row" key={post.id}>
        <div className="review-thumb">{post.media_type === 'video' ? <video src={post.media_url} muted /> : <img src={post.media_url} alt="" />}</div>
        <div className="review-details"><b>@{post.author?.username || 'creator'} · {post.kind}</b><p>{post.caption || 'No caption'}</p></div>
        <div className="review-actions"><button onClick={() => action('admin-feature', { postId: post.id, featured: !post.is_world_featured })}>{post.is_world_featured ? 'Remove from world' : 'Feature in world'}</button></div>
      </div>) : <p className="microcopy">Approved posts will be available for spotlight here.</p>}
    </div></section>;
}

function RightRail({ user, onCreate, onOpenProfile, onFollow, followingMap }: {
  user: User; onCreate: () => void; onOpenProfile: (profile: User) => void;
  onFollow: (profile: User) => void; followingMap: Record<string, boolean>;
}) {
  const [suggestions, setSuggestions] = useState<User[]>([]);
  useEffect(() => { callApi<{ users: User[] }>('suggestions', {}, getSessionToken()).then(r => setSuggestions(r.users)).catch(() => undefined); }, []);
  return <aside className="right-rail"><div className="rail-profile"><Avatar user={user} /><div><b>{user.username}</b><small>{user.display_name}</small></div><button onClick={() => onOpenProfile(user)}>VIEW</button></div>
    <div className="fame-card"><div className="fame-card-top"><span>YOUR FAME METER</span><Crown size={17} /></div><div className="fame-score">{user.follower_count.toLocaleString()}<small>followers</small></div><p>Every follow is someone choosing to see more of what you make.</p><div className="fame-line"><i style={{ width: Math.min(100, user.follower_count / 5000) + '%' }} /></div><span className="fame-caption"><Zap size={13} /> Keep creating. Your next milestone is waiting.</span></div>
    <div className="rail-section"><div className="rail-heading"><b>Creators to know</b><span>FOR YOU</span></div>{suggestions.length ? suggestions.slice(0, 5).map(p => {
      const isFollowing = followingMap[p.id] ?? !!p.is_following;
      return <div className="suggestion" key={p.id}><button className="suggestion-profile" onClick={() => onOpenProfile(p)}><Avatar user={p} size="sm" /><span><b>{p.username} {p.is_verified && <VerifiedBadge />}</b><small>{p.follower_count.toLocaleString()} followers</small></span></button><button className={'follow-link ' + (isFollowing ? 'following' : '')} onClick={() => onFollow(p)}>{isFollowing ? 'Following' : 'Follow'}</button></div>;
    }) : <p className="muted tiny">Creators will show up as the community grows.</p>}</div>
    <div className="rail-create"><div><Sparkles size={18} /><span>Have a moment to share?</span></div><button onClick={onCreate}>Create something <Plus size={15} /></button></div>
    <div className="rail-foot"><span>ABOUT</span><span>COMMUNITY</span><span>PRIVACY</span><span>HELP</span><p>© 2026 VYRA</p></div></aside>;
}

function SettingsPage({ token, user, onLogout, update, onCheckUpdates, onDownloadUpdate, onInstallUpdate }: {
  token: string; user: User; onLogout: () => void; update: UpdateUiState;
  onCheckUpdates: () => void; onDownloadUpdate: () => void; onInstallUpdate: () => void;
}) {
  const [tracks, setTracks] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [rights, setRights] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<'razorpay' | 'stripe'>('razorpay');
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<any>(null);
  const [paymentMessage, setPaymentMessage] = useState('');
  useEffect(() => { callApi<{ tracks: any[] }>('list-audio', {}, token).then(r => setTracks(r.tracks)).catch(() => undefined); }, [token]);
  useEffect(() => { callApi<{ connection: any }>('payment-status', {}, token).then(r => setPaymentStatus(r.connection)).catch(() => undefined); }, [token]);
  async function savePaymentKeys() {
    setBusy(true); setPaymentMessage('');
    try {
      const payload = provider === 'razorpay' ? { provider, keyId, keySecret } : { provider, secretKey: keySecret };
      await callApi('connect-payment', payload, token);
      setKeyId(''); setKeySecret('');
      setPaymentStatus({ provider, connected_at: new Date().toISOString() });
      setPaymentMessage('Your payment credentials are encrypted and stored on the server.');
    } catch (e) { setPaymentMessage(e instanceof Error ? e.message : 'Could not save payment credentials.'); }
    finally { setBusy(false); }
  }
  async function addTrack() {
    if (!audioFile || !title.trim() || !rights) return setMessage('Choose an audio file, add a title and confirm the rights.');
    setBusy(true); setMessage('');
    try {
      await uploadMedia(audioFile, 'audio', token, { title, artist, rightsConfirmation: 'I own or have permission to upload and use this recording.' });
      setTitle(''); setArtist(''); setAudioFile(null); setMessage('Audio track submitted to your library.');
      setTracks((await callApi<{ tracks: any[] }>('list-audio', {}, token)).tracks);
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Could not add audio.'); }
    finally { setBusy(false); }
  }
  return <div className="content-page settings-page"><div className="page-intro"><p className="eyebrow">YOUR ACCOUNT, YOUR RULES</p><h2>Settings & creator tools.</h2><p>Manage your identity, audio library and account session.</p></div>
    <div className="settings-card update-settings-card"><div className="settings-card-head"><RefreshCw /><div><h3>VYRA updates</h3><p>Find the newest release for this device whenever you check.</p></div></div>
      <div className="update-status-row" aria-live="polite"><span className={'update-state-dot update-state-' + update.phase} /><div className="update-status-copy"><b>Installed version v{APP_VERSION}</b><p>{update.message}</p>{update.latestVersion && <small>Latest published version v{update.latestVersion}</small>}</div></div>
      {update.phase === 'downloading' && update.progress !== undefined && <div className="update-progress" aria-label={'Download progress ' + Math.round(update.progress) + '%'}><span style={{ width: Math.max(0, Math.min(100, update.progress)) + '%' }} /></div>}
      <div className="update-actions"><button className="button button-primary" onClick={onCheckUpdates} disabled={update.phase === 'checking' || update.phase === 'downloading'}><RefreshCw size={15} /> {update.phase === 'checking' ? 'Checking…' : 'Update'}</button>
        {update.phase === 'available' && !window.vyraDesktop && <button className="button button-soft" onClick={onDownloadUpdate}>{Capacitor.getPlatform() === 'android' ? 'Download APK' : 'Open release downloads'}</button>}
        {update.phase === 'ready' && window.vyraDesktop && <button className="button button-primary" onClick={onInstallUpdate}>Restart & install</button>}
      </div>
      <p className="microcopy update-platform-note">{Capacitor.getPlatform() === 'android' ? 'Android will ask you to approve the APK installation. Because preview APKs are debug-signed, Android may require removing the previous preview build before installing a new one.' : window.vyraDesktop ? 'Windows downloads available updates automatically. Restart VYRA to finish installing.' : 'The web version opens the official VYRA release page for downloads.'}</p>
    </div>
    <div className="settings-card"><div className="settings-card-head"><Music2 /><div><h3>Your audio library</h3><p>Add MP3 or M4A recordings that you own or are licensed to use.</p></div></div>
      <div className="settings-form"><label>TRACK TITLE<input value={title} onChange={e => setTitle(e.target.value)} placeholder="Song or recording name" /></label><label>ARTIST<input value={artist} onChange={e => setArtist(e.target.value)} placeholder="Artist name" /></label>
        <label className="audio-file">AUDIO FILE<input type="file" accept="audio/mpeg,audio/mp4" onChange={e => setAudioFile(e.target.files?.[0] || null)} /></label><label className="check-line"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} /> I have the rights required to upload and use this audio.</label>
        <button className="button button-primary" onClick={addTrack} disabled={busy}>{busy ? 'Adding…' : 'Add to library'}</button>{message && <p className="microcopy">{message}</p>}
      </div>{tracks.map(track => <div className="track-row" key={track.id}><Music2 size={16} /><b>{track.title}</b><small>{track.artist}</small></div>)}
      <p className="microcopy">This is a rights-confirmed upload library, not an iTunes/Apple Music catalog or blanket music license.</p>
    </div>
    <div className="settings-card"><div className="settings-card-head"><Crown /><div><h3>Creator subscriptions</h3><p>Bring your own Razorpay account. Each creator connects their own payment keys.</p></div></div>
      {paymentStatus && <p className="payment-note"><ShieldCheck /><span>Connected provider: <b>{paymentStatus.provider}</b>. Credentials remain encrypted on the server.</span></p>}
      <div className="settings-form">
        <label>PAYMENT PROVIDER<select value={provider} onChange={e => setProvider(e.target.value as 'razorpay' | 'stripe')}><option value="razorpay">Razorpay</option><option value="stripe">Stripe</option></select></label>
        {provider === 'razorpay' && <label>RAZORPAY KEY ID<input value={keyId} onChange={e => setKeyId(e.target.value)} placeholder="rzp_test_…" autoComplete="off" /></label>}
        <label>{provider === 'razorpay' ? 'RAZORPAY KEY SECRET' : 'STRIPE SECRET KEY'}<input type="password" value={keySecret} onChange={e => setKeySecret(e.target.value)} placeholder={provider === 'razorpay' ? 'Your Razorpay secret' : 'sk_test_… or sk_live_…'} autoComplete="new-password" /></label>
        <button className="button button-primary" onClick={savePaymentKeys} disabled={busy || !keySecret || (provider === 'razorpay' && !keyId)}>{busy ? 'Encrypting securely…' : 'Save payment credentials'}</button>
        {paymentMessage && <p className="microcopy">{paymentMessage}</p>}
      </div>
      <div className="payment-note"><ShieldCheck /><span>Creators must create their own Razorpay API keys in their Razorpay Dashboard and enter them here. VYRA does not issue shared keys or ask creators to send secrets in chat; submitted credentials are encrypted server-side and never returned to the browser. This is secure key storage only—live checkout, verified webhooks and subscription renewals still need to be completed before charging subscribers.</span></div>
    </div>
    <div className="settings-card account-danger"><div className="settings-card-head"><LogOut /><div><h3>Sign out</h3><p>End your VYRA session on this device.</p></div></div><button className="button button-soft" onClick={onLogout}>Log out of @{user.username}</button></div>
  </div>;
}

function AppShell({ user: startUser, token, onLogout }: { user: User; token: string; onLogout: () => void }) {
  const [user, setUser] = useState(startUser);
  const [tab, setTab] = useState<Tab>('home');
  const [posts, setPosts] = useState<Post[]>([]);
  const [worldFeed, setWorldFeed] = useState<Post[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [dmTarget, setDmTarget] = useState<User | null>(null);
  const [sharePost, setSharePost] = useState<Post | null>(null);
  const [e2eeIdentity, setE2eeIdentity] = useState<E2EEIdentity | null>(null);
  const [callInfo, setCallInfo] = useState<any>(null);
  const closeCall = useCallback(() => setCallInfo(null), []);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [storyOpen, setStoryOpen] = useState<Story | null>(null);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [viewProfile, setViewProfile] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [updateReady, setUpdateReady] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateUiState>({ phase: 'idle', message: 'Tap Update to check for the newest VYRA release.' });
  const [mobileNav, setMobileNav] = useState(false);
  const pendingLikesRef = useRef(new Set<string>());
  const pendingFollowsRef = useRef(new Set<string>());
  const [followingMap, setFollowingMap] = useState<Record<string, boolean>>({});
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try { return localStorage.getItem('vyra-sound-enabled') === 'true'; } catch { return false; }
  });
  const [darkTheme, setDarkTheme] = useState(() => {
    try { return localStorage.getItem('vyra-dark-theme') !== 'false'; } catch { return true; }
  });
  const checkUpdates = useCallback(async () => {
    if (updateState.phase === 'checking' || updateState.phase === 'downloading') return;
    setUpdateState({ phase: 'checking', message: 'Checking the latest published VYRA release…' });
    try {
      const result = await checkLatestUpdate();
      if (!result.available) {
        setUpdateState({ phase: 'latest', latestVersion: result.latestVersion, message: `You’re already using the latest version of VYRA.` });
        return;
      }
      if (window.vyraDesktop) {
        setUpdateState({ phase: 'checking', latestVersion: result.latestVersion, releaseUrl: result.releaseUrl, message: `VYRA v${result.latestVersion} is available. Checking the Windows installer…` });
        window.vyraDesktop.checkForUpdates();
      } else {
        const isAndroid = Capacitor.getPlatform() === 'android';
        setUpdateState({
          phase: 'available', latestVersion: result.latestVersion,
          downloadUrl: isAndroid ? result.androidDownloadUrl : result.windowsDownloadUrl,
          releaseUrl: result.releaseUrl,
          message: `VYRA v${result.latestVersion} is available.`,
        });
      }
    } catch (error) {
      setUpdateState({ phase: 'error', message: error instanceof Error ? error.message : 'Could not check for updates. Please try again.' });
    }
  }, [updateState.phase]);
  const downloadUpdate = useCallback(async () => {
    const target = updateState.downloadUrl || updateState.releaseUrl;
    if (!target) return;
    try {
      if (Capacitor.getPlatform() !== 'web' && updateState.downloadUrl) await Browser.open({ url: updateState.downloadUrl });
      else window.open(updateState.releaseUrl || target, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setUpdateState(current => ({ ...current, phase: 'error', message: error instanceof Error ? error.message : 'Could not open the update download.' }));
    }
  }, [updateState.downloadUrl, updateState.releaseUrl]);
  const installUpdate = useCallback(() => {
    if (window.vyraDesktop) window.vyraDesktop.installUpdate();
    else window.dispatchEvent(new Event('vyra:apply-update'));
  }, []);
  useEffect(() => {
    try { localStorage.setItem('vyra-sound-enabled', String(soundEnabled)); } catch { /* Storage may be unavailable. */ }
    const root = document.querySelector('.app-shell');
    if (!root) return;
    const applyPreference = (node: Node) => {
      const videos: HTMLVideoElement[] = [];
      if (node instanceof HTMLVideoElement) videos.push(node);
      else if (node instanceof Element) videos.push(...Array.from(node.querySelectorAll('video')));
      videos.forEach(video => { if (video.dataset.vyraMuteLock !== 'true') video.muted = !soundEnabled; });
    };
    applyPreference(root);
    const observer = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(applyPreference)));
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [soundEnabled]);
  useEffect(() => {
    try { localStorage.setItem('vyra-dark-theme', String(darkTheme)); } catch { /* Storage may be unavailable. */ }
  }, [darkTheme]);
  const refreshUser = useCallback(async () => { const r = await callApi<{ user: User }>('me', {}, token); setUser(r.user); return r.user; }, [token]);
  const toggleSound = useCallback(() => setSoundEnabled(value => !value), []);
  const openProfile = useCallback((profile: User) => { setViewProfile(profile); setTab('profile'); }, []);
  const loadFeed = useCallback(async () => {
    const r = await callApi<{ posts: Post[]; stories: Story[]; worldFeed: Post[] }>('feed', {}, token);
    setPosts(r.posts); setStories(r.stories); setWorldFeed(r.worldFeed || []);
  }, [token]);
  useEffect(() => { Promise.all([refreshUser(), loadFeed()]).catch(e => setToast(e.message)).finally(() => setLoading(false)); }, [refreshUser, loadFeed]);
  useEffect(() => {
    const update = () => {
      setUpdateReady(true);
      setUpdateState(current => ({ ...current, phase: 'ready', message: `VYRA v${current.latestVersion || 'update'} is downloaded and ready to install.` }));
    };
    const desktopStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: string; version?: string; percent?: number; message?: string }>).detail;
      if (!detail?.status) return;
      const allowed: UpdatePhase[] = ['checking', 'latest', 'available', 'downloading', 'ready', 'error'];
      const phase = allowed.includes(detail.status as UpdatePhase) ? detail.status as UpdatePhase : 'error';
      setUpdateState(current => ({
        ...current,
        phase,
        latestVersion: detail.version || current.latestVersion,
        progress: detail.percent ?? current.progress,
        message: detail.message || (phase === 'checking' ? 'Checking for a Windows update…' : phase === 'available' ? `VYRA v${detail.version || current.latestVersion || ''} was found. Downloading…` : phase === 'latest' ? 'You’re already using the latest version of VYRA.' : phase === 'downloading' ? `Downloading VYRA update${detail.percent === undefined ? '…' : ` · ${Math.round(detail.percent)}%`}` : phase === 'ready' ? 'The update is downloaded and ready to install.' : 'Could not complete the update check.'),
      }));
      if (phase === 'ready') setUpdateReady(true);
    };
    const desktopError = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      setUpdateState(current => ({ ...current, phase: 'error', message: message || 'The Windows updater encountered an error.' }));
    };
    window.addEventListener('vyra:update-ready', update);
    window.addEventListener('vyra:desktop-update-ready', update);
    window.addEventListener('vyra:desktop-update-status', desktopStatus);
    window.addEventListener('vyra:desktop-update-error', desktopError);
    return () => {
      window.removeEventListener('vyra:update-ready', update);
      window.removeEventListener('vyra:desktop-update-ready', update);
      window.removeEventListener('vyra:desktop-update-status', desktopStatus);
      window.removeEventListener('vyra:desktop-update-error', desktopError);
    };
  }, []);
  useEffect(() => { const handler = (e: KeyboardEvent) => { if (user.is_admin && e.ctrlKey && e.key.toLowerCase() === 'q') { e.preventDefault(); setTab('admin'); } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [user.is_admin]);
  useEffect(() => { if (tab === 'notifications') callApi<{ notifications: any[] }>('notifications', {}, token).then(r => setNotifications(r.notifications)).catch(e => setToast(e.message)); }, [tab, token]);
  useEffect(() => {
    let active = true;
    const pollCalls = async () => {
      try {
        const result = await callApi<{ call: any | null }>('dm-call-poll', {}, token);
        if (!active) return;
        if (result.call) setCallInfo((current: any) =>
          current?.id === result.call.id && current.status === result.call.status ? current : result.call
        );
        else setCallInfo(null);
      } catch { /* Incoming call discovery retries without interrupting the feed. */ }
    };
    void pollCalls();
    const timer = window.setInterval(() => void pollCalls(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [token]);

  const like = useCallback(async (post: Post) => {
    if (pendingLikesRef.current.has(post.id)) return;
    pendingLikesRef.current.add(post.id);
    const wasLiked = post.liked;
    const delta = wasLiked ? -1 : 1;
    const apply = (items: Post[], liked: boolean, countDelta: number) => items.map(item =>
      item.id === post.id ? { ...item, liked, likes_count: Math.max(0, item.likes_count + countDelta) } : item
    );
    setPosts(items => apply(items, !wasLiked, delta));
    setWorldFeed(items => rankWorldFeed(apply(items, !wasLiked, delta)));
    try {
      const result = await callApi<{ liked: boolean }>('like', { postId: post.id }, token);
      if (result.liked !== !wasLiked) {
        const targetDelta = result.liked === wasLiked ? 0 : (result.liked ? 1 : -1);
        const correction = targetDelta - delta;
        setPosts(items => apply(items, result.liked, correction));
        setWorldFeed(items => rankWorldFeed(apply(items, result.liked, correction)));
      }
    } catch (error) {
      setPosts(items => apply(items, wasLiked, -delta));
      setWorldFeed(items => rankWorldFeed(apply(items, wasLiked, -delta)));
      setToast(error instanceof Error ? error.message : 'Could not update appreciation.');
    } finally { pendingLikesRef.current.delete(post.id); }
  }, [token]);
  const comment = useCallback(async (post: Post, text: string) => {
    const content = text.trim();
    if (!content) return;
    setPosts(items => items.map(item => item.id === post.id ? { ...item, comments_count: item.comments_count + 1 } : item));
    setWorldFeed(items => rankWorldFeed(items.map(item => item.id === post.id ? { ...item, comments_count: item.comments_count + 1 } : item)));
    try {
      await callApi('comment', { postId: post.id, content }, token);
      setToast('Comment shared.');
    } catch (error) {
      setPosts(items => items.map(item => item.id === post.id ? { ...item, comments_count: Math.max(0, item.comments_count - 1) } : item));
      setWorldFeed(items => rankWorldFeed(items.map(item => item.id === post.id ? { ...item, comments_count: Math.max(0, item.comments_count - 1) } : item)));
      setToast(error instanceof Error ? error.message : 'Could not post comment.');
      throw error;
    }
  }, [token]);
  async function runSearch() {
    if (!search.trim()) return setSearchResults([]);
    try { setSearchResults((await callApi<{ users: User[] }>('search-users', { query: search.trim() }, token)).users); }
    catch (e) { setToast(e instanceof Error ? e.message : 'Search failed.'); }
  }
  const follow = useCallback(async (profile: User) => {
    if (pendingFollowsRef.current.has(profile.id)) return;
    pendingFollowsRef.current.add(profile.id);
    const wasFollowing = followingMap[profile.id] ?? !!profile.is_following;
    setFollowingMap(current => ({ ...current, [profile.id]: !wasFollowing }));
    try {
      const result = await callApi<{ following: boolean }>('follow', { username: profile.username }, token);
      setFollowingMap(current => ({ ...current, [profile.id]: result.following }));
      setToast(result.following ? 'Following @' + profile.username : 'Unfollowed @' + profile.username);
      void refreshUser().catch(() => undefined);
    } catch (error) {
      setFollowingMap(current => ({ ...current, [profile.id]: wasFollowing }));
      setToast(error instanceof Error ? error.message : 'Could not update follow.');
    } finally { pendingFollowsRef.current.delete(profile.id); }
  }, [followingMap, token, refreshUser]);
  const recordView = useCallback(async (postId: string) => {
    try {
      const result = await callApi<{ views_count: number }>('record-view', { postId }, token);
      setPosts(items => items.map(p => p.id === postId ? { ...p, views_count: result.views_count } : p));
      setWorldFeed(items => rankWorldFeed(items.map(p => p.id === postId ? { ...p, views_count: result.views_count } : p)));
    } catch { /* A view counter should never interrupt playback. */ }
  }, [token]);
  const displayed = useMemo(() => tab === 'reels' ? posts.filter(p => p.kind === 'reel') : tab === 'explore' ? worldFeed : posts, [posts, worldFeed, tab]);
  if (loading) return <div className="loading-screen"><div className="loading-mark"><img src="./icon.svg" alt="VYRA" /></div><p>Preparing your stage…</p></div>;
  return <div className="app-shell" data-theme={darkTheme ? 'dark' : 'light'}><aside className={'sidebar ' + (mobileNav ? 'sidebar-open' : '')}>
    <button className="brand sidebar-brand" onClick={() => setTab('home')}><span className="brand-mark"><img src="./icon.svg" alt="" /></span> VYRA</button><div className="side-label">YOUR SPACE</div><nav className="side-nav">
      <button className={tab === 'home' ? 'active' : ''} onClick={() => { setTab('home'); setMobileNav(false); }}><Home /> Home</button>
      <button className={tab === 'reels' ? 'active' : ''} onClick={() => { setTab('reels'); setMobileNav(false); }}><Clapperboard /> Reels</button>
      <button className={tab === 'explore' ? 'active' : ''} onClick={() => { setTab('explore'); setMobileNav(false); }}><Compass /> World Feed</button>
      <button className={tab === 'messages' ? 'active' : ''} onClick={() => { setTab('messages'); setMobileNav(false); }}><MessageCircle /> Messages</button>
      <button onClick={() => setUploadOpen(true)}><Plus /> Create <span className="nav-plus">+</span></button>
      <button className={tab === 'notifications' ? 'active' : ''} onClick={() => { setTab('notifications'); setMobileNav(false); }}><Bell /> Notifications</button>
      <button className={tab === 'profile' ? 'active' : ''} onClick={() => { setViewProfile(null); setTab('profile'); setMobileNav(false); }}><UserRound /> Profile</button>
    </nav><div className="sidebar-bottom"><button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><Settings /> Settings</button>{user.is_admin && <button onClick={() => setTab('admin')}><ShieldCheck /> Admin</button>}<button onClick={onLogout}><LogOut /> Log out</button><div className="sidebar-user"><Avatar user={user} size="sm" /><span><b>{user.username}</b><small>Your creator space</small></span>{user.is_verified && <VerifiedBadge />}</div></div>
  </aside>
  {mobileNav && <button className="mobile-shade" onClick={() => setMobileNav(false)} aria-label="Close menu" />}
  <main className="main-column"><header className="topbar"><button className="mobile-menu icon-button" onClick={() => setMobileNav(!mobileNav)}><Menu /></button>
    <div className="topbar-title">{tab === 'home' ? 'Your feed' : tab === 'reels' ? 'Reels' : tab === 'explore' ? 'World Feed' : tab === 'messages' ? 'Messages' : tab === 'notifications' ? 'Notifications' : tab === 'settings' ? 'Settings' : tab === 'admin' ? 'Admin panel' : 'Creator profile'}<span className="live-dot" /></div>
    <div className="topbar-actions">
      <button className="global-sound-toggle" type="button" onClick={toggleSound} aria-label={soundEnabled ? 'Mute all videos' : 'Unmute all videos'} title={soundEnabled ? 'Mute all videos' : 'Unmute all videos'}><span className="global-control-icon">{soundEnabled ? <Volume2 size={17} /> : <VolumeX size={17} />}</span><span className="global-control-label">{soundEnabled ? 'Sound on' : 'Sound off'}</span></button>
      <button className={'theme-switch ' + (darkTheme ? 'is-dark' : 'is-light')} type="button" role="switch" aria-checked={darkTheme} aria-label={darkTheme ? 'Dark theme on. Switch to light theme.' : 'Dark theme off. Switch to dark theme.'} title={darkTheme ? 'Dark theme on' : 'Dark theme off'} onClick={() => setDarkTheme(value => !value)}><span className="theme-switch-icon">{darkTheme ? <Moon size={13} /> : <Sun size={13} />}</span><span className="theme-switch-track"><i /></span></button>
      <div className="top-search"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && runSearch()} placeholder="Find creators" /><button onClick={runSearch}>Search</button></div><button className="create-small" onClick={() => setUploadOpen(true)}><Plus size={17} /> Create</button></div>
  </header>
  {searchResults.length > 0 && <div className="search-results">{searchResults.map(p => <button key={p.id} onClick={() => { setViewProfile(p); setTab('profile'); setSearchResults([]); }}><Avatar user={p} size="sm" /><b>@{p.username}</b>{p.is_verified && <VerifiedBadge />}<span>{p.follower_count.toLocaleString()} followers</span><small>Open profile ↗</small></button>)}</div>}
  {tab === 'home' && <div className="feed-layout"><div className="feed-column"><StoryRail stories={stories} me={user} onAdd={() => setUploadOpen(true)} onOpen={setStoryOpen} /><div className="feed-heading"><div><p className="eyebrow">A LITTLE INSPIRATION, DAILY</p><h2>Moments worth sharing.</h2></div><span>FEED / 01</span></div>
    {displayed.length ? displayed.map(p => <PostCard key={p.id} post={p} token={token} soundEnabled={soundEnabled} onToggleSound={toggleSound} onLike={like} onComment={comment} onProfile={openProfile} onView={recordView} />) : <div className="empty-card"><div className="empty-icon"><Sparkles /></div><p className="eyebrow">THE STAGE IS YOURS</p><h3>Your feed is a blank canvas.</h3><p>Share the first moment, or discover creators who inspire you. Approved posts from the community will appear here.</p><button className="button button-primary" onClick={() => setUploadOpen(true)}><Plus size={16} /> Create your first post</button></div>}
  </div><RightRail user={user} onCreate={() => setUploadOpen(true)} onOpenProfile={openProfile} onFollow={follow} followingMap={followingMap} /></div>}
  {tab === 'reels' && <div className="content-page reels-page"><div className="page-intro"><p className="eyebrow">SHORT FORM, BIG ENERGY</p><h2>Reels that make you pause.</h2><p>Swipe vertically through creator videos. Videos play when they are in view.</p></div><ReelsFeed posts={displayed} soundEnabled={soundEnabled} onLike={like} onProfile={openProfile} onView={recordView} onComment={comment} onShare={setSharePost} token={token} /></div>}
  {tab === 'explore' && <div className="content-page"><div className="page-intro"><p className="eyebrow">A NEW DAY, A NEW DISCOVERY</p><h2>Today’s World Feed.</h2><p>Every new video joins automatically. Upload order starts the day; views, appreciations and comments move the ranking. Resets at midnight IST.</p></div>{displayed.length ? <div className="world-feed-list">{displayed.map(p => <PostCard key={p.id} post={p} token={token} soundEnabled={soundEnabled} onToggleSound={toggleSound} onLike={like} onComment={comment} onProfile={openProfile} onView={recordView} />)}</div> : <div className="empty-card"><Compass /><h3>Today’s World Feed is ready for its first video.</h3><p>Upload a video and it will appear here immediately. The feed starts fresh at midnight IST.</p><button className="button button-primary" onClick={() => setUploadOpen(true)}>Publish a video</button></div>}</div>}
  {tab === 'profile' && <div className="content-page"><ProfileView profile={viewProfile || user} own={!viewProfile || viewProfile.id === user.id} token={token} onRefresh={() => { refreshUser().then(() => loadFeed()); }} />{viewProfile && viewProfile.id !== user.id && <div className="profile-actions"><button className="button button-soft" onClick={() => { setDmTarget(viewProfile); setTab('messages'); }}><MessageCircle size={16} /> Message</button><button className={'button ' + ((followingMap[viewProfile.id] ?? !!viewProfile.is_following) ? 'button-soft following-button' : 'button-primary')} onClick={() => follow(viewProfile)}>{(followingMap[viewProfile.id] ?? !!viewProfile.is_following) ? 'Following' : 'Follow @' + viewProfile.username}</button></div>}</div>}
  {tab === 'messages' && <DirectMessages token={token} user={user} target={dmTarget} onClearTarget={() => setDmTarget(null)} onToast={setToast} onIdentityReady={setE2eeIdentity} onStartCall={setCallInfo} />}
  {tab === 'notifications' && <div className="content-page"><div className="page-intro"><p className="eyebrow">GOOD THINGS HAPPEN HERE</p><h2>Your notifications.</h2><p>Follows, appreciations and creator milestones.</p></div>{notifications.length ? notifications.map(n => <div className="notification-row" key={n.id}><span className="notification-icon"><Bell size={17} /></span><div><b>{n.message}</b><small>{ago(n.created_at)}</small></div></div>) : <div className="empty-card"><Bell /><h3>It's quiet for now.</h3><p>We'll let you know when something happens.</p></div>}</div>}
  {tab === 'settings' && <SettingsPage token={token} user={user} onLogout={onLogout} update={updateState} onCheckUpdates={checkUpdates} onDownloadUpdate={downloadUpdate} onInstallUpdate={installUpdate} />}
  {tab === 'admin' && user.is_admin && <AdminPanel token={token} onClose={() => setTab('home')} />}
  <footer className="app-footer"><span>VYRA © 2026</span><span>BUILT BY GEMAA ✦</span><span>REAL FAME. REAL PEOPLE.</span><span>MADE FOR CREATORS</span></footer></main>
  {uploadOpen && <UploadModal token={token} onClose={() => setUploadOpen(false)} onDone={() => loadFeed()} />}
  {sharePost && <ShareSheet post={sharePost} token={token} identity={e2eeIdentity} onClose={() => setSharePost(null)} onToast={setToast} />}
  {callInfo && <CallOverlay call={callInfo} user={user} token={token} onClose={closeCall} onToast={setToast} />}
  {storyOpen && <div className="modal-backdrop story-viewer" onClick={() => setStoryOpen(null)}><div className="story-viewer-card" onClick={e => e.stopPropagation()}><button className="icon-button story-close" onClick={() => setStoryOpen(null)}><X /></button>{storyOpen.media_type === 'video' ? <VYRAPlayer src={storyOpen.media_url} soundEnabled={soundEnabled} onToggleSound={toggleSound} autoPlay className="story-video-player" /> : <img src={storyOpen.media_url} alt={storyOpen.caption} />}<div><b>@{storyOpen.author.username}</b><p>{storyOpen.caption}</p></div></div></div>}
  {updateReady && <div className="update-toast"><span><Activity size={18} /> A fresh VYRA update is ready.</span><button onClick={() => {
    installUpdate();
  }}>Update now</button><button className="update-dismiss" onClick={() => setUpdateReady(false)}><X size={16} /></button></div>}
  {toast && <button className="toast" onClick={() => setToast('')}>{toast} <X size={14} /></button>}
  </div>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(getSessionToken());
  const [checking, setChecking] = useState(Boolean(getSessionToken()));
  useEffect(() => {
    if (!token) { setChecking(false); return; }
    callApi<{ user: User }>('me', {}, token).then(r => setUser(r.user)).catch(() => { clearSessionToken(); setToken(null); }).finally(() => setChecking(false));
  }, [token]);
  const logout = () => { if (token) callApi('logout', {}, token).catch(() => undefined); clearSessionToken(); setToken(null); setUser(null); };
  if (checking) return <div className="loading-screen"><div className="loading-mark"><img src="./icon.svg" alt="VYRA" /></div><p>Getting your space ready…</p></div>;
  if (!user || !token) return <Welcome onAuth={(u, t) => { setUser(u); setToken(t); }} />;
  return <AppShell user={user} token={token} onLogout={logout} />;
}
