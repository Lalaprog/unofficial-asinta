'use client';

import React from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'raised' | 'flat' | 'inset' | 'interactive';
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant = 'raised', children, ...props }, ref) => {
    const variantClasses = {
      raised: 'bg-white border border-surface-border shadow-sm rounded-xl',
      flat: 'bg-white border border-surface-border rounded-xl',
      inset: 'bg-surface-inset/60 border border-surface-border/80 rounded-lg',
      interactive:
        'bg-white border border-surface-border hover:border-brand/35 hover:shadow-sm transition-colors duration-150 cursor-pointer rounded-xl focus-within:ring-2 focus-within:ring-brand/15',
    };

    return (
      <div
        ref={ref}
        className={twMerge(clsx(variantClasses[variant], 'p-5 md:p-6 transition-colors', className))}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';

export const CardHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div className={twMerge(clsx('flex flex-col space-y-1.5 pb-4', className))} {...props}>
    {children}
  </div>
);

export const CardTitle: React.FC<React.HTMLAttributes<HTMLHeadingElement>> = ({
  className,
  children,
  ...props
}) => (
  <h3
    className={twMerge(
      clsx('text-lg font-semibold text-navy tracking-tight leading-none', className)
    )}
    {...props}
  >
    {children}
  </h3>
);

export const CardDescription: React.FC<React.HTMLAttributes<HTMLParagraphElement>> = ({
  className,
  children,
  ...props
}) => (
  <p className={twMerge(clsx('text-xs text-ink-secondary mt-1', className))} {...props}>
    {children}
  </p>
);

export const CardContent: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => <div className={twMerge(clsx('pt-0', className))} {...props}>{children}</div>;

export const CardFooter: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div className={twMerge(clsx('flex items-center pt-4 border-t border-surface-border/60', className))} {...props}>
    {children}
  </div>
);
