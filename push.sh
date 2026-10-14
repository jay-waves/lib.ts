git checkout --orphan latest
git add -A
git commit -m "$(date)"

git branch -M main
git push -f origin main
