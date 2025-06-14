const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const axios = require("axios");

// Initialize with explicit configuration
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://graduation-project-31ccf.firebaseio.com"
});

const OPEN_WEATHER_API_KEY = "4af409a4c67493e64a7c44c96d9c51e3";

exports.dailyFloodCheck = functions.pubsub
  .schedule("0 0 * * *") // Runs at midnight every day
  .timeZone("Africa/Cairo") // Set to Alexandria's timezone
  .onRun(async (context) => {
    console.log('--- Daily Flood Check Started ---');
    
    try {
      // 1. Get weather forecast for Alexandria
      console.log('Fetching 5-day weather forecast...');
      const weatherResponse = await axios.get(
        `https://api.openweathermap.org/data/2.5/forecast?q=Alexandria,EG&appid=${OPEN_WEATHER_API_KEY}&units=metric`
      );
      
      const forecasts = weatherResponse.data.list;
      console.log(`Received ${forecasts.length} forecast periods`);
      
      // 2. Process each forecast period and predict flood risk
      const highRiskPeriods = [];
      let maxDailyRisk = 0;
      
      // Group forecasts by day and find maximum risk per day
      const dailyRisks = {};
      
      for (const forecast of forecasts) {
        try {
          const forecastDate = new Date(forecast.dt * 1000);
          const dateKey = forecastDate.toISOString().split('T')[0]; // YYYY-MM-DD
          
          const floodRisk = await predictFloodRisk(forecast);
          console.log(`Forecast for ${forecastDate} - Flood Risk: ${floodRisk}%`);
          
          // Track maximum risk for the day
          if (!dailyRisks[dateKey] || floodRisk > dailyRisks[dateKey].risk) {
            dailyRisks[dateKey] = {
              risk: floodRisk,
              time: forecastDate,
              weather: forecast.weather[0].main,
              rain: forecast.rain ? forecast.rain["3h"] || 0 : 0
            };
          }
          
          if (floodRisk*100 >= 60) {
            highRiskPeriods.push({
              date: dateKey,
              time: forecastDate.toLocaleTimeString(),
              risk: floodRisk,
              weather: forecast.weather[0].main,
              rain: forecast.rain ? forecast.rain["3h"] || 0 : 0
            });
          }
          
          // Track overall maximum risk
          if (floodRisk > maxDailyRisk) {
            maxDailyRisk = floodRisk;
          }
        } catch (error) {
          console.error(`Error processing forecast:`, error);
        }
      }
      
      // 3. Prepare notification based on risk level
      const todayKey = new Date().toISOString().split('T')[0];
      const todayRisk = dailyRisks[todayKey]?.risk || 0;
      
      if (maxDailyRisk >= 60) {
        console.log(`High flood risk detected (${maxDailyRisk}%)`);
        await sendDangerNotification(highRiskPeriods, maxDailyRisk*100);
      } else {
        console.log('No high flood risk detected');
        await sendSafeNotification(todayRisk*100);
      }
      
      // 4. Log the daily assessment
      await admin.firestore().collection("daily_flood_checks").add({
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        maxRisk: maxDailyRisk,
        todayRisk: todayRisk,
        highRiskPeriods: highRiskPeriods,
        allDailyRisks: dailyRisks
      });
      
    } catch (error) {
      console.error('!!! CRITICAL ERROR !!!', {
        errorMessage: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
    }

    console.log('--- Daily Check Completed ---');
    return null;
  });

async function predictFloodRisk(forecast) {
  try {
    const predictionData = {
      Year: new Date(forecast.dt * 1000).getFullYear(),
      Month: new Date(forecast.dt * 1000).getMonth() + 1,
      Max_Temp: forecast.main.temp_max,
      Min_Temp: forecast.main.temp_min,
      Rainfall: forecast.rain ? forecast.rain["3h"] || 0 : 0,
      Relative_Humidity: forecast.main.humidity,
      Wind_Speed: forecast.wind.speed,
      Cloud_Coverage: forecast.clouds.all,
      Bright_Sunshine: forecast.main.feels_like,
      ALT: 250.0 // Alexandria's approximate elevation
    };

    const response = await axios.post(
      "https://minanasser.pythonanywhere.com/predict",
      predictionData,
      { headers: { "Content-Type": "application/json" } }
    );

    return response.data.flood_prediction;
  } catch (error) {
    console.error('Flood prediction error:', error);
    return 0;
  }
}

async function sendDangerNotification(highRiskPeriods, maxRisk) {
  try {
    const usersSnapshot = await admin.firestore().collection("users_tokens").get();
    const tokens = usersSnapshot.docs.map(doc => doc.data().fcmToken).filter(Boolean);
    
    if (tokens.length === 0) return;

    // Group risks by day
    const risksByDay = {};
    highRiskPeriods.forEach(period => {
      const date = new Date(period.time);
      const dayKey = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      
      if (!risksByDay[dayKey]) {
        risksByDay[dayKey] = {
          maxRisk: period.risk,
          periods: []
        };
      }
      
      risksByDay[dayKey].periods.push({
        time: date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        risk: period.risk
      });
      
      if (period.risk > risksByDay[dayKey].maxRisk) {
        risksByDay[dayKey].maxRisk = period.risk;
      }
    });

    // Build notification message
    const dangerDays = Object.keys(risksByDay);
    const isMultiDay = dangerDays.length > 1;
    
    const message = {
      notification: {
        title: isMultiDay ? 
          `⚠️ Flood Risk (${dangerDays.length} Days)` : 
          "⚠️ Flood Risk Alert",
        body: buildNotificationBody(risksByDay, isMultiDay),
      },
      data: {
        type: "danger",
        days: JSON.stringify(risksByDay),
        click_action: "FLUTTER_NOTIFICATION_CLICK"
      },
      tokens: tokens,
    };

    await admin.messaging().sendEachForMulticast(message);
  } catch (error) {
    console.error('Notification error:', error);
  }
}

function buildNotificationBody(risksByDay, isMultiDay) {
  if (isMultiDay) {
    const dayList = Object.entries(risksByDay)
      .map(([day, data]) => `${day} (${data.maxRisk}%)`)
      .join(', ');
    return `High flood risk expected on: ${dayList}. Stay alert!`;
  } else {
    const [day, data] = Object.entries(risksByDay)[0];
    return `High flood risk (${data.maxRisk}%) expected on ${day}. Be prepared!`;
  }
}

async function sendSafeNotification(todayRisk) {
  try {
    const usersSnapshot = await admin.firestore().collection("users_tokens").get();
    const tokens = usersSnapshot.docs.map(doc => doc.data().fcmToken).filter(Boolean);
    
    if (tokens.length === 0) {
      console.warn('No valid FCM tokens found');
      return;
    }
    
    const message = {
      notification: {
        title: "🌤️ Good News!",
        body: `Good morning! Today's flood risk is low (${todayRisk}%). Have a safe day!`,
      },
      data: {
        type: "safe",
        riskLevel: todayRisk.toString(),
        click_action: "FLUTTER_NOTIFICATION_CLICK"
      },
      tokens: tokens,
    };
    
    console.log('Sending safe day notifications...');
    await admin.messaging().sendEachForMulticast(message);
    
  } catch (error) {
    console.error('Safe notification error:', error);
  }
}