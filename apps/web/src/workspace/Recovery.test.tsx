import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { Recovery } from './Recovery';

vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(api).mockReset();
  window.history.replaceState(null, '', '/forgot-password');
});
const renderRecovery = () =>
  render(
    <MemoryRouter>
      <Recovery />
    </MemoryRouter>,
  );
it('gives the same neutral confirmation after requesting recovery', async () => {
  vi.mocked(api).mockResolvedValue({ ok: true });
  renderRecovery();
  fireEvent.change(screen.getByLabelText(/^E-mailadres/), {
    target: { value: 'person@example.org' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Herstellink versturen' }));
  await screen.findByRole('status');
  expect(screen.getByRole('status')).toHaveTextContent('Als dit e-mailadres');
  expect(api).toHaveBeenCalledWith(
    '/auth/password/forgot',
    expect.objectContaining({ body: JSON.stringify({ email: 'person@example.org' }) }),
  );
});
it('retains the form after a failed request', async () => {
  vi.mocked(api).mockRejectedValue(new Error('Probeer later opnieuw'));
  renderRecovery();
  fireEvent.change(screen.getByLabelText(/^E-mailadres/), {
    target: { value: 'person@example.org' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Herstellink versturen' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Probeer later opnieuw');
  expect(screen.getByLabelText(/^E-mailadres/)).toHaveValue('person@example.org');
});
it('requires a reset token and matching passwords', async () => {
  window.history.replaceState(null, '', '/reset-password');
  renderRecovery();
  expect(screen.getByRole('button', { name: 'Wachtwoord wijzigen' })).toBeDisabled();
});
it('removes a consumed token from browser history and asks the user to sign in', async () => {
  window.history.replaceState(null, '', '/reset-password#token=single-use');
  vi.mocked(api).mockResolvedValue({ ok: true });
  renderRecovery();
  fireEvent.change(screen.getByLabelText(/^Nieuw wachtwoord/), {
    target: { value: 'a-new-safe-password' },
  });
  fireEvent.change(screen.getByLabelText(/^Wachtwoord herhalen/), {
    target: { value: 'a-new-safe-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Wachtwoord wijzigen' }));
  await waitFor(() => expect(window.location.hash).toBe(''));
  expect(screen.getByRole('status')).toHaveTextContent('Log opnieuw in');
});
it('never submits mismatched new passwords', async () => {
  window.history.replaceState(null, '', '/reset-password#token=single-use');
  renderRecovery();
  fireEvent.change(screen.getByLabelText(/^Nieuw wachtwoord/), {
    target: { value: 'a-new-safe-password' },
  });
  fireEvent.change(screen.getByLabelText(/^Wachtwoord herhalen/), {
    target: { value: 'a-different-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Wachtwoord wijzigen' }));
  expect(screen.getByRole('alert')).toHaveTextContent('komen niet overeen');
  expect(api).not.toHaveBeenCalled();
});
