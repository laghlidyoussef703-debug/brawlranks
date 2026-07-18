"use client";

import Image from "next/image";
import { useId, useRef, useState } from "react";

export const SUPPORT_EMAIL = "support@brawlranks.com";
export const MESSAGE_MAX_LENGTH = 2000;

export const CONTACT_CATEGORIES = [
  "Report wrong data",
  "Suggest a correction",
  "Copyright request",
  "Partnership inquiry",
  "Technical issue",
  "General inquiry",
] as const;

interface FieldErrors {
  name?: string;
  email?: string;
  category?: string;
  message?: string;
  website?: string;
}

const LABEL_CLASS = "block font-display text-[0.78rem] uppercase tracking-wide text-white";
const FIELD_CLASS =
  "min-h-[39px] w-full rounded-[6px] border border-[#315a9a] bg-[rgb(3_20_55_/_0.94)] px-3.5 py-2 text-[0.9rem] text-white placeholder:text-[#9eacc4] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]";
const ERROR_CLASS = "mt-1 block text-[0.76rem] font-semibold text-[#ffd23f]";

// A pragmatic something@something.tld shape check, not full RFC 5322 —
// server-side validation is where strictness belongs once a real
// submission backend exists.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(values: { name: string; email: string; category: string; message: string; website: string }): FieldErrors {
  const errors: FieldErrors = {};
  if (values.name.trim().length < 2) errors.name = "Please enter your name (at least 2 characters).";
  if (values.name.trim().length > 100) errors.name = "Please keep your name under 100 characters.";
  if (!EMAIL_SHAPE.test(values.email.trim())) errors.email = "Please enter a valid email address.";
  if (!CONTACT_CATEGORIES.includes(values.category as (typeof CONTACT_CATEGORIES)[number]))
    errors.category = "Please select a category.";
  if (values.message.trim().length < 10) errors.message = "Please describe your request (at least 10 characters).";
  if (values.message.length > MESSAGE_MAX_LENGTH)
    errors.message = `Please keep your message under ${MESSAGE_MAX_LENGTH} characters.`;
  if (values.website.trim() !== "") errors.website = "Please leave this field blank.";
  return errors;
}

/**
 * The contact form's interactive island. No submission backend exists in
 * this repository (no email provider, no contact Server Action, no
 * contact API route — verified before this component was written), so
 * submitting never pretends to send: a valid submission shows a
 * transparent "form delivery is still being prepared" notice pointing at
 * the verified support address instead. Nothing is silently discarded
 * and no fake success state exists anywhere in this component.
 */
export function ContactForm({ inboxIconSrc, calendarIconSrc }: { inboxIconSrc: string; calendarIconSrc: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [attempted, setAttempted] = useState(false);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  const fieldIds = {
    name: `${id}-name`,
    email: `${id}-email`,
    category: `${id}-category`,
    message: `${id}-message`,
    website: `${id}-website`,
  };

  function handleSubmit(event: { preventDefault(): void }) {
    event.preventDefault();
    const nextErrors = validate({ name, email, category, message, website });
    setErrors(nextErrors);
    setAttempted(true);
    if (Object.keys(nextErrors).length === 0) {
      statusRef.current?.focus();
    }
  }

  const isValidAttempt = attempted && Object.keys(errors).length === 0;
  const mailtoHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    category ? `BrawlRanks — ${category}` : "BrawlRanks contact"
  )}`;

  return (
    <form onSubmit={handleSubmit} noValidate aria-describedby={`${id}-form-status`}>
      <div className="grid gap-3 tablet:grid-cols-2">
        <div>
          <label htmlFor={fieldIds.name} className={LABEL_CLASS}>
            Your Name
          </label>
          <div className="relative mt-1.5">
            <span aria-hidden="true" className="pointer-events-none absolute left-3 top-[10px] h-3.5 w-3.5 rounded-full border-2 border-[#b8c8e3] after:absolute after:-bottom-[7px] after:left-1/2 after:h-[7px] after:w-[14px] after:-translate-x-1/2 after:rounded-t-full after:border-x-2 after:border-t-2 after:border-[#b8c8e3]" />
            <input
              id={fieldIds.name}
              name="name"
              type="text"
              autoComplete="name"
              placeholder="Enter your name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? `${fieldIds.name}-error` : undefined}
              className={`${FIELD_CLASS} pl-10`}
            />
          </div>
          {errors.name && (
            <span id={`${fieldIds.name}-error`} className={ERROR_CLASS}>
              {errors.name}
            </span>
          )}
        </div>

        <div>
          <label htmlFor={fieldIds.email} className={LABEL_CLASS}>
            Your Email
          </label>
          <div className="relative mt-1.5">
            <Image
              src={inboxIconSrc}
              alt=""
              aria-hidden="true"
              width={136}
              height={109}
              className="pointer-events-none absolute left-3 top-1/2 h-5 w-6 -translate-y-1/2 object-contain"
            />
            <input
              id={fieldIds.email}
              name="email"
              type="email"
              autoComplete="email"
              placeholder="Enter your email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? `${fieldIds.email}-error` : undefined}
              className={`${FIELD_CLASS} pl-10`}
            />
          </div>
          {errors.email && (
            <span id={`${fieldIds.email}-error`} className={ERROR_CLASS}>
              {errors.email}
            </span>
          )}
        </div>
      </div>

      <div className="mt-3">
        <label htmlFor={fieldIds.category} className={LABEL_CLASS}>
          Category
        </label>
        <div className="relative mt-1.5">
          <Image
            src={calendarIconSrc}
            alt=""
            aria-hidden="true"
            width={121}
            height={128}
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 object-contain"
          />
          <select
            id={fieldIds.category}
            name="category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-invalid={errors.category ? true : undefined}
            aria-describedby={errors.category ? `${fieldIds.category}-error` : undefined}
            className={`${FIELD_CLASS} appearance-none pl-10 pr-10 ${category === "" ? "text-[#9eacc4]" : ""}`}
          >
            <option value="" disabled>
              Select a category
            </option>
            {CONTACT_CATEGORIES.map((option) => (
              <option key={option} value={option} className="text-white">
                {option}
              </option>
            ))}
          </select>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-4 top-1/2 block h-2 w-2 -translate-y-[70%] rotate-45 border-b-2 border-r-2 border-[#c8d7f2]"
          />
        </div>
        {errors.category && (
          <span id={`${fieldIds.category}-error`} className={ERROR_CLASS}>
            {errors.category}
          </span>
        )}
      </div>

      <div className="mt-3">
        <label htmlFor={fieldIds.message} className={LABEL_CLASS}>
          Message
        </label>
        <div className="relative mt-1.5">
          <textarea
            id={fieldIds.message}
            name="message"
            rows={4}
            placeholder="Describe your request in detail..."
            value={message}
            maxLength={MESSAGE_MAX_LENGTH}
            onChange={(event) => setMessage(event.target.value)}
            aria-invalid={errors.message ? true : undefined}
            aria-describedby={`${fieldIds.message}-count${errors.message ? ` ${fieldIds.message}-error` : ""}`}
            className={`${FIELD_CLASS} min-h-[96px] resize-y pb-7 pl-10`}
          />
          <span aria-hidden="true" className="pointer-events-none absolute left-3 top-3 block h-5 w-2.5 rotate-45 rounded-sm border border-[#b8c8e3] before:absolute before:-top-1 before:left-0 before:h-1 before:w-full before:bg-[#b8c8e3]" />
          <span
            id={`${fieldIds.message}-count`}
            className="pointer-events-none absolute bottom-2.5 right-4 text-[0.7rem] text-[#8fa0bd]"
          >
            {message.length}/{MESSAGE_MAX_LENGTH}
          </span>
        </div>
        {errors.message && (
          <span id={`${fieldIds.message}-error`} className={ERROR_CLASS}>
            {errors.message}
          </span>
        )}
      </div>

      {/* Honeypot, visible-but-subtle exactly as in the approved reference
          composition — real visitors are told to leave it blank, and a
          non-empty value fails validation. No stronger anti-spam claim is
          made anywhere because none exists yet. */}
      <div className="mt-3">
        <label htmlFor={fieldIds.website} className={`${LABEL_CLASS} font-body font-normal text-[#b8c8df]`}>
          Your Website <span className="normal-case">(leave blank)</span>
        </label>
        <input
          id={fieldIds.website}
          name="website"
          type="text"
          autoComplete="off"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
          aria-invalid={errors.website ? true : undefined}
          aria-describedby={errors.website ? `${fieldIds.website}-error` : undefined}
          className={`mt-1.5 ${FIELD_CLASS}`}
        />
        {errors.website && (
          <span id={`${fieldIds.website}-error`} className={ERROR_CLASS}>
            {errors.website}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-3 tablet:flex-row tablet:items-stretch">
        <p className="relative flex min-h-[63px] flex-1 items-center rounded-[6px] border border-[#315a9a] bg-[rgb(7_43_106_/_0.8)] py-2.5 pl-11 pr-3 text-[0.75rem] leading-relaxed text-[#d4dff0]">
          <span aria-hidden="true" className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 rounded-[3px] border-2 border-[#dce6f7] before:absolute before:-top-[8px] before:left-1/2 before:h-2.5 before:w-3 before:-translate-x-1/2 before:rounded-t-full before:border-x-2 before:border-t-2 before:border-[#dce6f7]" />
          By submitting this form, you agree that BrawlRanks may use your details to respond to your request. A full
          privacy policy page is still being prepared.
        </p>
        <button
          type="submit"
          className="flex min-h-[63px] w-full shrink-0 items-center justify-center rounded-[6px] border-[2px] border-[#8a5a06] bg-[linear-gradient(180deg,#ffe066,#f5ac00)] px-8 font-display text-[1.08rem] uppercase tracking-wide text-[#3a2400] shadow-[0_4px_0_#8a5a06] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] tablet:w-[200px]"
        >
          Send Message
        </button>
      </div>

      <div
        id={`${id}-form-status`}
        ref={statusRef}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
      >
        {isValidAttempt && (
          <div className="mt-4 rounded-[8px] border-[2px] border-[#8a5a06] bg-[rgb(60_38_2_/_0.55)] px-4 py-3 text-[0.78rem] leading-relaxed text-[#ffe4a3]">
            <strong className="font-display uppercase tracking-wide">Your message was not sent.</strong> The
            contact form&apos;s delivery system is still being prepared. Please email us directly at{" "}
            <a
              href={mailtoHref}
              className="font-semibold text-[#ffd23f] underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
            >
              {SUPPORT_EMAIL}
            </a>{" "}
            — your details above were not stored or transmitted anywhere.
          </div>
        )}
      </div>
    </form>
  );
}
