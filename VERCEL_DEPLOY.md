# Vercel Deployment Guide for Sickly Ignite

## Prerequisites

1. [Vercel Account](https://vercel.com/signup) (free tier available)
2. [GitHub Account](https://github.com) with your repository pushed
3. Africa's Talking API credentials

## Step 1: Prepare Your Repository

Your code is already configured for Vercel deployment with:
- ✅ `vercel.json` - Deployment configuration
- ✅ `api/` directory - Serverless functions
- ✅ `lib/db.js` - Database abstraction layer
- ✅ `.vercelignore` - Files excluded from deployment

## Step 2: Deploy to Vercel

### Option A: Deploy via Vercel Dashboard (Recommended)

1. Go to [https://vercel.com/new](https://vercel.com/new)
2. Click "Import Project"
3. Select your GitHub repository: `sheldon34/sickly-ignite`
4. Select the `hamisi` branch
5. Configure project:
   - **Framework Preset**: Other
   - **Root Directory**: `./` (leave as default)
   - **Build Command**: (leave empty)
   - **Output Directory**: (leave empty)
6. Click "Deploy"

### Option B: Deploy via Vercel CLI

```bash
# Install Vercel CLI
npm install -g vercel

# Login to Vercel
vercel login

# Deploy
vercel

# Deploy to production
vercel --prod
```

## Step 3: Set Up Upstash Redis Database

1. In your Vercel project dashboard, go to **Storage** tab
2. Click "Create Database"
3. Select "Upstash Redis" from the marketplace
4. Click "Continue" and follow the setup wizard
5. Once created, Vercel will automatically add these environment variables:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

**Manual Setup (Alternative):**
1. Go to [https://console.upstash.com/](https://console.upstash.com/)
2. Create a new Redis database (free tier available)
3. Copy the REST API credentials
4. Add them to Vercel environment variables (see Step 4)

## Step 4: Configure Environment Variables

In your Vercel project dashboard:

1. Go to **Settings** → **Environment Variables**
2. Add the following variables:

| Variable Name | Value | Description |
|--------------|-------|-------------|
| `AT_USERNAME` | `sandbox` or your production username | Africa's Talking username |
| `AT_API_KEY` | Your API key | Get from [Africa's Talking Dashboard](https://account.africastalking.com/apps/sandbox/settings/key) |
| `UPSTASH_REDIS_REST_URL` | Auto-added if using Vercel Storage | Redis connection URL |
| `UPSTASH_REDIS_REST_TOKEN` | Auto-added if using Vercel Storage | Redis auth token |
| `CRON_SECRET` | Generate random string | Secures cron endpoints. Generate with: `openssl rand -base64 32` |
| `AT_SENDER_ID` | (Optional) Your sender ID | For custom SMS sender |

3. Click "Save" for each variable
4. Redeploy your app for changes to take effect

## Step 5: Configure Africa's Talking Callbacks

After deployment, Vercel will provide you with a URL (e.g., `https://your-app.vercel.app`)

1. Go to [Africa's Talking USSD Settings](https://account.africastalking.com/apps/sandbox/ussd/channels)
2. Update USSD Callback URL:
   ```
   https://your-app.vercel.app/ussd
   ```

3. Go to [Africa's Talking SMS Settings](https://account.africastalking.com/apps/sandbox/sms/callback)
4. Update SMS Delivery Reports URL:
   ```
   https://your-app.vercel.app/sms
   ```

## Step 6: Migrate Existing Data (If Needed)

If you have existing patient data in JSON files:

```bash
# Set environment variables locally
export UPSTASH_REDIS_REST_URL="your_url_here"
export UPSTASH_REDIS_REST_TOKEN="your_token_here"

# Run migration script (Coming soon - manual upload for now)
# node scripts/migrate-to-kv.js
```

**Manual Migration:**
1. Use the dashboard "Seed Test Data" button to populate initial data
2. Or manually add data via the dashboard

## Step 7: Verify Deployment

1. **Test the Dashboard:**
   - Visit `https://your-app.vercel.app`
   - You should see the Sickly Ignite dashboard

2. **Test USSD:**
   - Dial `*384*39981#` (or your USSD code)
   - Register a test patient

3. **Check Logs:**
   - Go to Vercel Dashboard → **Deployments** → Click latest deployment → **Functions**
   - View logs for any errors

4. **Test Cron Job:**
   - Go to Vercel Dashboard → **Cron Jobs**
   - View execution history
   - Manually trigger if needed

## Troubleshooting

### Issue: Database not connecting

**Solution:**
- Verify `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set
- Check Vercel function logs for connection errors
- Ensure Redis database is in the same region as your Vercel deployment (recommended)

### Issue: USSD not responding

**Solution:**
- Verify callback URL is correctly set in Africa's Talking
- Check Vercel function logs at `/api/index`
- Ensure URL is HTTPS (not HTTP)
- Test the endpoint directly: `curl https://your-app.vercel.app/ussd`

### Issue: Medication reminders not sending

**Solution:**
- Check Vercel Cron Jobs tab for execution status
- Verify `CRON_SECRET` environment variable is set
- Check `/api/cron/medication-reminders` logs
- Ensure Africa's Talking API credentials are correct

### Issue: "Module not found" errors

**Solution:**
- Verify all dependencies are in `package.json`
- Redeploy the application
- Check build logs in Vercel dashboard

## Important Notes

1. **Data Persistence:** With Upstash Redis, your data persists across deployments
2. **Cold Starts:** First request after inactivity may be slow (~2-5 seconds)
3. **Cron Limitations:** Vercel Cron runs at most once per minute
4. **Function Timeout:** Free tier has 10-second timeout (upgrade for 60 seconds)
5. **Local Development:** Still works with JSON files when Redis is not configured

## Cost

- **Vercel**: Free tier includes:
  - Unlimited deployments
  - 100 GB bandwidth
  - Serverless function executions

- **Upstash Redis**: Free tier includes:
  - 10,000 commands/day
  - 256 MB storage
  - Perfect for small-scale diabetes monitoring

## Support

- **Vercel Docs**: https://vercel.com/docs
- **Upstash Docs**: https://docs.upstash.com/
- **Africa's Talking**: https://developers.africastalking.com/

## Next Steps

1. Monitor your deployment in Vercel dashboard
2. Set up custom domain (optional): Vercel → Settings → Domains
3. Enable analytics: Vercel → Analytics tab
4. Scale to production: Upgrade plans as needed

---

**Deployment Complete!** 🎉

Your Sickly Ignite diabetes monitoring system is now running on Vercel with:
- ✅ Persistent Redis database
- ✅ Automated medication reminders (Vercel Cron)
- ✅ USSD & SMS integration
- ✅ Real-time dashboard with notifications
- ✅ SOS alert system
