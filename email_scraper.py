import requests
from bs4 import BeautifulSoup
import re
import csv

def scrape_emails_from_url(url):
    """
    Scrape email addresses from a single URL
    Returns a set of unique email addresses
    """
    emails = set()
    
    try:
        # Fetch the webpage with timeout
        response = requests.get(url, timeout=10, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        response.raise_for_status()
        
        # Parse HTML
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Remove script and style elements to avoid false positives
        for element in soup(['script', 'style']):
            element.decompose()
        
        # Method 1: Extract from mailto links
        for link in soup.find_all('a', href=True):
            if link['href'].startswith('mailto:'):
                email = link['href'].replace('mailto:', '').split('?')[0]
                emails.add(email.lower().strip())
        
        # Method 2: Extract from text content using regex
        text = soup.get_text()
        combined_text = text + " " + response.text
        
        # Regex pattern for email addresses
        email_pattern = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
        found_emails = re.findall(email_pattern, combined_text)
        
        # Validate and clean emails
        for email in found_emails:
            email = email.lower().strip()
            # Basic validation
            if '@' in email and '.' in email.split('@')[1]:
                # Remove common false positives
                if not email.endswith(('.png', '.jpg', '.gif', '.css', '.js')):
                    emails.add(email)
        
        return emails
        
    except Exception as e:
        print(f"Error scraping {url}: {e}")
        return set()


def scrape_multiple_urls(urls, output_file='scraped_emails.csv'):
    """
    Scrape emails from multiple URLs and save to CSV
    """
    all_emails = set()
    results_per_site = {}
    
    print(f"Starting to scrape {len(urls)} URLs...\n")
    
    for url in urls:
        print(f"Scraping: {url}")
        site_emails = scrape_emails_from_url(url)
        results_per_site[url] = site_emails
        all_emails.update(site_emails)
        
        if site_emails:
            print(f"  ✓ Found {len(site_emails)} email(s)")
        else:
            print(f"  ✗ No emails found")
    
    # Save to CSV with source URL
    with open(output_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Email', 'Source URL'])
        
        for url, emails in results_per_site.items():
            for email in sorted(emails):
                writer.writerow([email, url])
    
    # Save unique emails to separate file
    unique_file = 'unique_' + output_file
    with open(unique_file, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Email'])
        for email in sorted(all_emails):
            writer.writerow([email])
    
    # Print summary
    print(f"\n{'='*50}")
    print(f"Scraping Complete!")
    print(f"Total URLs scraped: {len(urls)}")
    print(f"URLs with emails: {sum(1 for emails in results_per_site.values() if emails)}")
    print(f"Total unique emails: {len(all_emails)}")
    print(f"\nResults saved to:")
    print(f"  • {output_file} (with source URLs)")
    print(f"  • {unique_file} (unique emails only)")
    
    return all_emails


# Example usage:
if __name__ == "__main__":
    print("=" * 60)
    print("EMAIL SCRAPER - Enter URLs to scrape for email addresses")
    print("=" * 60)
    
    # Allow user to choose mode
    print("\nChoose an option:")
    print("1. Enter URLs interactively (one at a time)")
    print("2. Use example URLs (demo mode)")
    
    choice = input("\nEnter your choice (1 or 2): ").strip()
    
    urls_to_scrape = []
    
    if choice == "1":
        # Interactive mode - allow user to enter all URLs
        print("\nEnter URLs to scrape (type 'done' when finished):")
        print("Example: https://example.com/contact\n")
        
        while True:
            url_input = input("Enter URL (or 'done' to finish): ").strip()
            
            if url_input.lower() == 'done':
                break
            
            # Basic URL validation
            if url_input:
                if not url_input.startswith(('http://', 'https://')):
                    url_input = 'https://' + url_input
                
                urls_to_scrape.append(url_input)
                print(f"  ✓ Added: {url_input}")
            else:
                print("  ✗ Empty URL, skipping...")
        
        if not urls_to_scrape:
            print("\nNo URLs entered. Exiting.")
        else:
            print(f"\n{'='*60}")
            print(f"You entered {len(urls_to_scrape)} URL(s). Starting scrape...")
            print(f"{'='*60}\n")
            all_emails = scrape_multiple_urls(urls_to_scrape)
    
    elif choice == "2":
        # Demo mode with example URLs
        print("\nUsing example URLs for demonstration...")
        urls_to_scrape = [
            "https://example.com/contact",
            "https://example.com/about",
            "https://example.com/team"
        ]
        all_emails = scrape_multiple_urls(urls_to_scrape)
    
    else:
        print("Invalid choice. Exiting.")
