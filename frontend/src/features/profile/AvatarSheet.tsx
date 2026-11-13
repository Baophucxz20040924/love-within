import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../../lib/apiClient';
import { cropSquare } from '../../lib/image';
import { profileApi, uploadAvatar } from './api';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Who will see the photo, worded for the current space (the couple app never mentions the friends space). */
  hint: string;
}

const errorText = (err: unknown) => (err instanceof ApiRequestError || err instanceof Error ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

/** Change or remove my profile photo: center square crop on the phone, preview, then save. */
export function AvatarSheet({ open, onClose, hint }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me, refreshMe } = useAuth();
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) return;
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });
  }, [open]);

  const name = me?.user.displayName ?? '';
  const current = me?.user.avatarUrl ?? null;

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const blob = await cropSquare(file, 512, 0.85);
      setPreview((p) => {
        if (p) URL.revokeObjectURL(p.url);
        return { blob, url: URL.createObjectURL(blob) };
      });
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  /** Every screen that shows my photo refetches (feeds carry author photos). */
  async function afterChange(message: string) {
    await refreshMe();
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['stories'] }),
      qc.invalidateQueries({ queryKey: ['friends'] }),
      qc.invalidateQueries({ queryKey: ['couple'] }),
    ]);
    toast.success(message);
    onClose();
  }

  async function save() {
    if (!preview) return;
    setBusy(true);
    try {
      await uploadAvatar(preview.blob);
      await afterChange('Đã cập nhật ảnh đại diện');
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await profileApi.removeAvatar();
      await afterChange('Đã gỡ ảnh đại diện');
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Ảnh đại diện">
      <div className="stack avatar-sheet">
        <div className="avatar-sheet__preview">
          {preview ? <img src={preview.url} alt="Ảnh mới" /> : <Avatar name={name} src={current} size={128} />}
        </div>
        <p className="text-sm text-muted center">{hint}</p>
        {preview ? (
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => pickRef.current?.click()}>
              Chọn ảnh khác
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
              {busy && <span className="spinner" aria-hidden="true" />}
              Lưu
            </button>
          </div>
        ) : (
          <div className="list">
            <button type="button" className="list__item" disabled={busy} onClick={() => pickRef.current?.click()}>
              <span className="icon-tile" aria-hidden="true">
                <Icon name="image" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label">Chọn ảnh</span>
              </span>
            </button>
            <button type="button" className="list__item" disabled={busy} onClick={() => cameraRef.current?.click()}>
              <span className="icon-tile" aria-hidden="true">
                <Icon name="camera" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label">Chụp ảnh</span>
              </span>
            </button>
            {current && (
              <button type="button" className="list__item" disabled={busy} onClick={() => void remove()}>
                <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                  <Icon name="trash" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label text-danger">Gỡ ảnh</span>
                </span>
              </button>
            )}
          </div>
        )}
        <input ref={pickRef} type="file" accept="image/*" hidden onChange={(e) => void onFile(e)} />
        <input ref={cameraRef} type="file" accept="image/*" capture="user" hidden onChange={(e) => void onFile(e)} />
      </div>
    </BottomSheet>
  );
}
