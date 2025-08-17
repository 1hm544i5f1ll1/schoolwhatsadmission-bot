import os

def get_file_content(file_path):
    """
    Reads a file and retrieves its entire content.
    """
    try:
        if file_path.endswith(('.txt', '.js', '.py', '.csv', '.env', '.json', '.html')):
            with open(file_path, 'r', encoding='utf-8') as file:
                return file.read().strip()
        else:
            return "Binary or non-text file - Content preview not supported."
    except Exception as e:
        return f"Error reading file: {e}"

def scrape_directory(directory_path, output_file="directory_structure_with_content.txt"):
    """
    Scrapes files and folders from a directory and includes the entire content of files.
    """
    with open(output_file, 'w', encoding='utf-8') as output:
        # Traverse the directory
        for root, dirs, files in os.walk(directory_path):
            # Add folder details
            relative_path = os.path.relpath(root, directory_path)
            output.write(f"Folder: {relative_path}\n")
            
            # List subfolders
            if dirs:
                output.write(f"  Subfolders: {', '.join(dirs)}\n")
            else:
                output.write(f"  Subfolders: None\n")
            
            # List files and their content
            if files:
                output.write(f"  Files:\n")
                for file in files:
                    file_path = os.path.join(root, file)
                    output.write(f"    - {file}\n")
                    content = get_file_content(file_path)
                    output.write(f"      Content:\n{content}\n\n")
            else:
                output.write(f"  Files: None\n\n")
    print(f"Directory structure and full content saved to {output_file}")

# Specify the directory path
directory_path = '.'  # Current directory, change as needed

# Call the function
scrape_directory(directory_path, "directory_structure_with_content.txt")
