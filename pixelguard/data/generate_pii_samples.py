#!/usr/bin/env python3
"""generate_pii_samples.py — Synthetic PII test set for PixelGuard evaluation.
Generates data/pii_test_set.json with labeled rows for each PII category.
Deterministic under --seed.
Usage: python data/generate_pii_samples.py --per-category 200 --seed 26171
"""
from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path


def luhn_valid(card_number: str) -> bool:
    digits = re.sub(r"\D", "", card_number)
    if len(digits) < 13:
        return False
    s = 0
    alt = False
    for d in reversed(digits):
        n = int(d)
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        s += n
        alt = not alt
    return s % 10 == 0


def generate_luhn_card() -> str:
    while True:
        prefix = random.choice(["4", "5", "3", "6"])
        body = "".join(random.choices("0123456789", k=14))
        card = prefix + body + "0"
        digits = card
        s = 0
        alt = False
        for d in reversed(digits):
            n = int(d)
            if alt:
                n *= 2
                if n > 9:
                    n -= 9
            s += n
            alt = not alt
        check = (10 - (s % 10)) % 10
        card = card[:-1] + str(check)
        if luhn_valid(card):
            return f"{card[:4]} {card[4:8]} {card[8:12]} {card[12:16]}"


def luhn_fail_card() -> str:
    while True:
        digits = "".join(random.choices("0123456789", k=16))
        if not luhn_valid(digits):
            return f"{digits[:4]} {digits[4:8]} {digits[8:12]} {digits[12:16]}"


def generate_email() -> str:
    names = ["rohan", "priya", "arjun", "neha", "vikram", "ananya", "karan", "divya"]
    domains = ["gmail.com", "yahoo.in", "outlook.com", "example.com", "hotmail.com"]
    name = random.choice(names)
    num = random.randint(10, 999)
    domain = random.choice(domains)
    return f"Contact {name}{num}@{domain} for the application."


def generate_phone() -> str:
    start = random.choice([6, 7, 8, 9])
    body = "".join(random.choices("0123456789", k=9))
    phone = f"{start}{body}"
    if random.random() < 0.5:
        return f"Mobile: +91 {phone[:5]} {phone[5:]}"
    return f"Reach me at {phone}"


def generate_card() -> str:
    card = generate_luhn_card()
    return f"Payment card: {card}"


def generate_aadhaar() -> str:
    first = random.randint(2, 9)
    rest = "".join(random.choices("0123456789", k=11))
    aadhaar = f"{first}{rest}"
    formatted = f"{aadhaar[:4]} {aadhaar[4:8]} {aadhaar[8:]}"
    if random.random() < 0.5:
        return f"Aadhaar number: {formatted}"
    return f"UID: {formatted}"


def generate_name() -> str:
    first_names = ["Rohan", "Priya", "Arjun", "Neha", "Vikram", "Ananya", "Karan", "Divya", "Asha", "Rahul"]
    last_names = ["Sharma", "Verma", "Patel", "Singh", "Reddy", "Nair", "Gupta", "Mehta"]
    return f"Name: {random.choice(first_names)} {random.choice(last_names)}"


def generate_pan() -> str:
    first = random.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    letters = "".join(random.choices("ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=4))
    digits = "".join(random.choices("0123456789", k=4))
    last = random.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    return f"PAN: {first}{letters}{digits}{last}"


def generate_ssn() -> str:
    area = random.randint(100, 999)
    group = random.randint(10, 99)
    serial = random.randint(1000, 9999)
    return f"SSN: {area}-{group}-{serial}"


def generate_passport() -> str:
    letter = random.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    digits = "".join(random.choices("0123456789", k=7))
    return f"Passport: {letter}{digits}"


def generate_cvv() -> str:
    cvv = "".join(random.choices("0123456789", k=3))
    return f"CVV: {cvv}"


def generate_ip() -> str:
    parts = [str(random.randint(0, 255)) for _ in range(4)]
    return f"Server IP: {'.'.join(parts)}"


def generate_negative_luhn_fail() -> str:
    card = luhn_fail_card()
    return f"Test ID: {card}"


def generate_negative_aadhaar_zero() -> str:
    digits = "0" + "".join(random.choices("0123456789", k=11))
    return f"Order ID: {digits}"


def generate_negative_order_id() -> str:
    first = random.randint(1, 5)
    oid = str(first) + "".join(random.choices("0123456789", k=9))
    return f"Order #{oid}"


def generate_dob() -> str:
    d = random.randint(1, 28)
    m = random.randint(1, 12)
    y = random.randint(1960, 2005)
    return f"Date of birth: {d:02d}/{m:02d}/{y}"


def generate_ifsc() -> str:
    bank = random.choice(["SBIN", "HDFC", "ICIC", "AXIS", "KOTK"])
    branch = "".join(random.choices("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", k=6))
    return f"IFSC code: {bank}0{branch}"


def generate_bank_account() -> str:
    # 15 or 17 digits — avoids 16-digit overlap with cards; ensure NOT Luhn-valid
    length = random.choice([15, 17, 18])
    while True:
        acct = "".join(random.choices("0123456789", k=length))
        if not luhn_valid(acct):
            break
    return f"Account number: {acct}"


def generate_driving_license() -> str:
    state = random.choice(["MH", "DL", "KA", "TN", "UP"])
    rto = random.randint(1, 99)
    year = random.randint(2008, 2024)
    serial = "".join(random.choices("0123456789", k=7))
    return f"Driving license: {state}-{rto:02d}-{year}-{serial}"


def generate_mac() -> str:
    return "MAC: " + ":".join("".join(random.choices("0123456789ABCDEF", k=2)) for _ in range(6))


def generate_url() -> str:
    domains = ["example.com", "api.service.io", "portal.gov.in", "secure.bank.net"]
    params = ["token", "key", "session", "auth", "ref"]
    val = "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=12))
    return f"Link: https://{random.choice(domains)}/api?{random.choice(params)}={val}"


def generate_negative_pincode() -> str:
    pin = "".join(random.choices("0123456789", k=6))
    return f"Delivery pincode {pin} for the package"


def generate_negative_clean() -> str:
    sentences = [
        "The weather is nice today.",
        "Please submit your application before the deadline.",
        "This is a training sandbox with synthetic data only.",
        "The portal will be available from 9 AM to 5 PM.",
        "Thank you for visiting the Seva Portal.",
    ]
    return random.choice(sentences)


def main():
    parser = argparse.ArgumentParser(description="Generate synthetic PII test set")
    parser.add_argument("--per-category", type=int, default=200, help="Samples per category")
    parser.add_argument("--seed", type=int, default=26171, help="Random seed for determinism")
    parser.add_argument("--output", default=None, help="Output path")
    args = parser.parse_args()

    random.seed(args.seed)

    rows = []
    per_cat = args.per_category

    generators = [
        ("email", generate_email),
        ("phone", generate_phone),
        ("card", generate_card),
        ("aadhaar_like", generate_aadhaar),
        ("pan", generate_pan),
        ("ssn", generate_ssn),
        ("passport", generate_passport),
        ("cvv", generate_cvv),
        ("ip", generate_ip),
        ("dob", generate_dob),
        ("ifsc", generate_ifsc),
        ("bank_account", generate_bank_account),
        ("driving_license", generate_driving_license),
        ("device_id", generate_mac),
        ("url", generate_url),
        ("name", generate_name),
    ]

    for category, gen in generators:
        for _ in range(per_cat):
            rows.append({"text": gen(), "category": category})

    negative_gens = [
        generate_negative_luhn_fail,
        generate_negative_aadhaar_zero,
        generate_negative_order_id,
        generate_negative_pincode,
        generate_negative_clean,
    ]

    neg_per_type = per_cat // len(negative_gens)
    for gen in negative_gens:
        for _ in range(neg_per_type):
            rows.append({"text": gen(), "category": None})

    random.shuffle(rows)

    output_path = Path(args.output) if args.output else Path(__file__).parent / "pii_test_set.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n")

    print(f"Generated {len(rows)} rows -> {output_path}")
    by_cat = {}
    for r in rows:
        c = r["category"] or "negative"
        by_cat[c] = by_cat.get(c, 0) + 1
    for c, n in sorted(by_cat.items()):
        print(f"  {c}: {n}")


if __name__ == "__main__":
    main()
