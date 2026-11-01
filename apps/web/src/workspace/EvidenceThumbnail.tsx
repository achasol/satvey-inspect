import { useEffect, useState } from 'react';
import { mediaURL } from './api';
import { protectedURL } from './platform';

export function EvidenceThumbnail({ org, id, name }: { org: string; id: string; name: string }) {
  const [src, setSrc] = useState(''),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    try {
      setSrc(protectedURL(mediaURL(org, id)));
    } catch {
      setFailed(true);
    }
  }, [org, id]);
  return src && !failed ? (
    <img src={src} alt={name} loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <span>{failed ? 'Foto niet beschikbaar' : 'Foto laden…'}</span>
  );
}
