import type { ReactNode } from 'react';
import { StateProvider } from './StateProvider';
import { ThemeProvider } from './ThemeProvider';

type Props = {
  children: ReactNode;
};

export const Providers = ({ children }: Props) => {
  return (
    <ThemeProvider>
      <StateProvider>{children}</StateProvider>
    </ThemeProvider>
  );
};
