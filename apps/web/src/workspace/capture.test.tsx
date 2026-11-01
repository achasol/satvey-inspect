import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Gallery } from './capture';

it('shows retired audio as unavailable and renders a player only for retained audio', () => {
  const { container } = render(
    <Gallery
      org="org"
      media={[
        {
          id: 'retired',
          batchId: 'batch',
          kind: 'audio',
          name: 'Oude opname',
          mime: 'audio/wav',
          contentDeletedAt: '2026-11-01T10:00:00Z',
        },
        {
          id: 'current',
          batchId: 'batch',
          kind: 'audio',
          name: 'Bewaarde opname',
          mime: 'audio/wav',
        },
      ]}
    />,
  );
  expect(screen.getByText('Originele audio verwijderd volgens het bewaarbeleid.')).toBeVisible();
  expect(screen.queryByLabelText('Oude opname')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Bewaarde opname')).toBeInTheDocument();
  expect(container.querySelectorAll('audio')).toHaveLength(1);
});
