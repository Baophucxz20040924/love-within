import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getVerificationStatus, subscribeVerification } from '../realtime/verification';
import './PostVideo.css';

/** Never autoplay. Hiding retained private trees must stop audio as well as the picture. */
export function PostVideo({ src, label = 'Video bài viết' }: { src: string; label?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const verification = useSyncExternalStore(subscribeVerification, getVerificationStatus, () => 'clear' as const);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const pause = () => video.pause();
    const visibility = () => { if (document.visibilityState !== 'visible') pause(); };
    document.addEventListener('visibilitychange', visibility);
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) pause();
    });
    observer?.observe(video);
    return () => { pause(); observer?.disconnect(); document.removeEventListener('visibilitychange', visibility); };
  }, [src]);
  useEffect(() => { if (verification !== 'clear') ref.current?.pause(); }, [verification]);
  return <div className="post-video">
    <video ref={ref} src={src} controls playsInline preload="metadata" aria-label={label}
      onPlay={() => { if (verification !== 'clear' || document.visibilityState !== 'visible') ref.current?.pause(); }}
      onError={() => setFailed(true)} />
    {failed && <p className="post-video__error" role="status">Không phát được video này. Khả năng phát MP4, WebM và MOV phụ thuộc codec và trình duyệt. Hãy thử tải lại hoặc dùng trình duyệt khác.</p>}
  </div>;
}
