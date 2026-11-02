'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '@/components/icon';

export function CountryPicker({
  countries,
  value,
  onChange,
}: {
  countries: { code: string; name: string }[];
  value: string;
  onChange: (code: string) => void;
}) {
  const choices = [{ code: '', name: '全部國家' }, ...countries];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  const show = () => {
    setActive(
      Math.max(
        0,
        choices.findIndex((country) => country.code === value),
      ),
    );
    setOpen(true);
  };
  const choose = (index: number) => {
    onChange(choices[index].code);
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  useEffect(() => {
    const option = document.getElementById(`${listId}-${active}`);
    const menu = list.current;
    if (!open || !option || !menu) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (
      option.offsetTop + option.offsetHeight >
      menu.scrollTop + menu.clientHeight
    )
      menu.scrollTop =
        option.offsetTop + option.offsetHeight - menu.clientHeight;
  }, [open, active, listId]);

  return (
    <div
      className="country-picker"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          setOpen(false);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setOpen(false);
          return;
        }
        if (
          !['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(
            event.key,
          )
        )
          return;
        event.preventDefault();
        if (!open) {
          show();
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') choose(active);
        else if (event.key === 'Home') setActive(0);
        else if (event.key === 'End') setActive(choices.length - 1);
        else
          setActive((index) =>
            Math.max(
              0,
              Math.min(
                choices.length - 1,
                index + (event.key === 'ArrowDown' ? 1 : -1),
              ),
            ),
          );
      }}
    >
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className="country-trigger"
        aria-label="目的地國家／地區"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        title="選擇國家／地區"
        onClick={() => (open ? setOpen(false) : show())}
      >
        <Icon name="chevron-down" size={18} />
      </button>
      {open && (
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label="選擇目的地國家／地區"
          className="country-menu"
        >
          {choices.map((country, index) => (
            <button
              key={country.code}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={country.code === value}
              tabIndex={-1}
              className={`country-option${active === index ? ' active' : ''}`}
              onPointerMove={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              {country.name}
              {country.code === value && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
